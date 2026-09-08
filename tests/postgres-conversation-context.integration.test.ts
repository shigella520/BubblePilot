import { randomUUID } from "node:crypto";

import { Client } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import { ConversationContextService } from "../modules/workflow/conversation-context-service.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(testDatabaseUrl !== undefined)(
  "ConversationContextService PostgreSQL integrity",
  () => {
    let archive: PostgresArchiveRepository;
    const successfulResult = {
      status: "succeeded",
      text: "Merged fictional summary",
      toolCalls: [],
      providerId: "55555555-5555-4555-8555-555555555555",
      providerName: "Fictional provider",
      providerVersion: 1,
      model: "fictional-model",
      routeVersion: 1,
      round: 1,
      attemptCount: 1,
      durationMs: 8,
      diagnostics: null,
    } as const;
    const execute = vi.fn();

    beforeEach(() => {
      // Vitest restores mock implementations after every test. Reinstall the
      // routing result so each PostgreSQL case remains independent.
      execute.mockResolvedValue(successfulResult);
    });

    beforeAll(() => {
      archive = new PostgresArchiveRepository(testDatabaseUrl ?? "");
    });

    afterAll(async () => {
      await archive.close();
    });

    it("removes schema fields retained only for legacy compatibility", async () => {
      const database = new Client({ connectionString: testDatabaseUrl });
      await database.connect();
      try {
        const columns = await database.query<{
          table_name: string;
          column_name: string;
        }>(
          `SELECT table_name, column_name
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND (table_name, column_name) IN (
               ('conversation_summary_settings', 'message_limit'),
               ('conversation_summary_settings', 'compression_batch_size'),
               ('ai_web_search_settings', 'total_timeout_ms'),
               ('conversation_context_states', 'workflow_id'),
               ('conversation_context_states', 'node_id'),
               ('conversation_context_states', 'profile_hash'),
               ('conversation_context_states', 'rebuilding'),
               ('conversation_context_compressions', 'execution_id'),
               ('workflow_versions', 'needs_resave')
             )`,
        );
        expect(columns.rows).toEqual([]);
        const retiredRebuilds = await database.query<{
          active_rebuilds: string;
        }>(
          `SELECT COUNT(*)::text AS active_rebuilds
           FROM conversation_context_compressions
           WHERE reason = 'policy-rebuild'
             AND status IN ('queued', 'running')`,
        );
        expect(retiredRebuilds.rows[0]).toEqual({ active_rebuilds: "0" });
      } finally {
        await database.end();
      }
    });

    async function archiveMessages(chatGuid: string, count: number) {
      const adapter = new BlueBubblesWebhookAdapter();
      const envelopes = [];
      for (let index = 1; index <= count; index += 1) {
        const normalized = adapter.normalize(
          newMessageWebhook({
            messageGuid: `${chatGuid}-message-${index}`,
            chatGuid,
            chatDisplayName: "Fictional summary chat",
            text: `Fictional message ${index}`,
          }),
          randomUUID(),
        );
        if (normalized.kind !== "message") throw new Error("Expected message");
        await archive.ingestMessage(normalized.envelope, true);
        envelopes.push(normalized.envelope);
      }
      return envelopes;
    }

    it("selects the newest complete window for automatic backlog recovery", async () => {
      const chatGuid = `iMessage;-;summary-backlog-${randomUUID()}`;
      const envelopes = await archiveMessages(chatGuid, 8);
      const service = new ConversationContextService(testDatabaseUrl ?? "", {
        execute,
      } as unknown as AiRoutingService);
      const database = new Client({ connectionString: testDatabaseUrl });
      await database.connect();
      try {
        const trigger = await service.enqueueForMessage({
          provider: "bluebubbles",
          providerChatId: chatGuid,
          providerMessageId:
            envelopes.at(-1)?.message.providerMessageId ?? "missing",
          routeId: randomUUID(),
          baseMessageWindow: 2,
          redundancyMessageWindow: 2,
          includeFromMe: true,
          timeZone: "UTC",
          summaryPolicyVersion: 1,
        });
        expect(trigger.compressionOperationId).toBeDefined();
        const operation = await database.query<{
          reason: string;
          from_index: string;
          through_index: string;
          trigger_message_index: string;
        }>(
          `SELECT reason, from_index::text, through_index::text,
                  trigger_message_index::text
           FROM conversation_context_compressions WHERE id = $1`,
          [trigger.compressionOperationId],
        );
        expect(operation.rows[0]).toMatchObject({
          reason: "backlog-fast-forward",
          from_index: "5",
          through_index: "6",
          trigger_message_index: "8",
        });
        await database.query(
          `WITH cancelled AS (
             UPDATE conversation_context_compressions
             SET status = 'superseded', updated_at = NOW()
             WHERE id = $1 AND status = 'queued'
             RETURNING context_state_id
           )
           UPDATE conversation_context_states state
           SET status = 'idle', updated_at = NOW()
           FROM cancelled
           WHERE state.id = cancelled.context_state_id`,
          [trigger.compressionOperationId],
        );
      } finally {
        await database.end();
        await service.close();
      }
    });

    it("resets a summary from only the newest rolling window", async () => {
      const chatGuid = `iMessage;-;summary-manual-reset-${randomUUID()}`;
      const envelopes = await archiveMessages(chatGuid, 8);
      const routeId = randomUUID();
      const service = new ConversationContextService(testDatabaseUrl ?? "", {
        execute,
      } as unknown as AiRoutingService);
      const database = new Client({ connectionString: testDatabaseUrl });
      await database.connect();
      try {
        await service.enqueueForMessage({
          provider: "bluebubbles",
          providerChatId: chatGuid,
          providerMessageId:
            envelopes.at(-1)?.message.providerMessageId ?? "missing",
          routeId,
          baseMessageWindow: 2,
          redundancyMessageWindow: 2,
          includeFromMe: true,
          timeZone: "UTC",
          summaryPolicyVersion: 1,
        });
        await service.processQueued(routeId, "UTC", `initial-${randomUUID()}`);
        const chat = await database.query<{ id: string }>(
          "SELECT id FROM chats WHERE provider_chat_id = $1",
          [chatGuid],
        );
        execute.mockResolvedValueOnce({
          ...successfulResult,
          text: "Reset fictional summary",
        });
        const reset = await service.resetChatSummary(chat.rows[0]?.id ?? "", {
          enabled: true,
          providerRouteId: routeId,
          baseMessageWindow: 2,
          redundancyMessageWindow: 2,
          includeFromMe: true,
          timeZone: "UTC",
          policyVersion: 1,
        });
        expect(reset).toMatchObject({ status: "created", messageCount: 2 });
        if (reset.status !== "created") return;

        const queued = await database.query<{
          reason: string;
          from_index: string;
          through_index: string;
          summary: string;
          covered_through_index: string;
        }>(
          `SELECT operation.reason, operation.from_index::text,
                  operation.through_index::text, state.summary,
                  state.covered_through_index::text
           FROM conversation_context_compressions operation
           INNER JOIN conversation_context_states state
             ON state.id = operation.context_state_id
           WHERE operation.id = $1`,
          [reset.id],
        );
        expect(queued.rows[0]).toMatchObject({
          reason: "manual-reset",
          from_index: "5",
          through_index: "6",
          summary: "",
          covered_through_index: "4",
        });

        await service.processQueued(routeId, "UTC", `reset-${randomUUID()}`);
        const lastCall = execute.mock.calls.at(-1)?.[0] as
          { messages: Array<{ content: string }> } | undefined;
        const prompt = lastCall?.messages;
        expect(prompt?.[1]?.content).toContain(
          "<previous_summary>\n\n</previous_summary>",
        );
        expect(prompt?.[1]?.content).toContain("Fictional message 5");
        expect(prompt?.[1]?.content).toContain("Fictional message 6");
        expect(prompt?.[1]?.content).not.toContain("Fictional message 4");
        expect(prompt?.[1]?.content).not.toContain("Fictional message 7");

        const completed = await database.query<{
          status: string;
          summary: string;
          covered_through_index: string;
        }>(
          `SELECT operation.status, state.summary,
                  state.covered_through_index::text
           FROM conversation_context_compressions operation
           INNER JOIN conversation_context_states state
             ON state.id = operation.context_state_id
           WHERE operation.id = $1`,
          [reset.id],
        );
        expect(completed.rows[0]).toMatchObject({
          status: "succeeded",
          summary: "Reset fictional summary",
          covered_through_index: "6",
        });
      } finally {
        await database.end();
        await service.close();
      }
    });

    it("finishes a fixed queued range after monitoring is disabled", async () => {
      const chatGuid = `iMessage;-;summary-disable-${randomUUID()}`;
      const envelopes = await archiveMessages(chatGuid, 3);
      const service = new ConversationContextService(testDatabaseUrl ?? "", {
        execute,
      } as unknown as AiRoutingService);
      const database = new Client({ connectionString: testDatabaseUrl });
      await database.connect();
      try {
        const trigger = await service.enqueueForMessage({
          provider: "bluebubbles",
          providerChatId: chatGuid,
          providerMessageId:
            envelopes.at(-1)?.message.providerMessageId ?? "missing",
          routeId: randomUUID(),
          baseMessageWindow: 2,
          redundancyMessageWindow: 1,
          includeFromMe: true,
          timeZone: "UTC",
          summaryPolicyVersion: 1,
        });
        expect(trigger.compressionOperationId).toBeDefined();
        await database.query(
          "UPDATE chats SET enabled = FALSE WHERE provider_chat_id = $1",
          [chatGuid],
        );

        await expect(
          service.processQueued(randomUUID(), "UTC", `test-${randomUUID()}`),
        ).resolves.toBe(true);
        const operation = await database.query<{
          status: string;
          summary: string;
          covered_through_index: string;
        }>(
          `SELECT operation.status, state.summary,
                  state.covered_through_index::text
           FROM conversation_context_compressions operation
           INNER JOIN conversation_context_states state
             ON state.id = operation.context_state_id
           WHERE operation.id = $1`,
          [trigger.compressionOperationId],
        );
        expect(operation.rows[0]).toMatchObject({
          status: "succeeded",
          summary: "Merged fictional summary",
          covered_through_index: "1",
        });
      } finally {
        await database.end();
        await service.close();
      }
    });

    it("regenerates the exact historical input without changing the committed summary", async () => {
      const chatGuid = `iMessage;-;summary-regenerate-${randomUUID()}`;
      const envelopes = await archiveMessages(chatGuid, 3);
      const routeId = randomUUID();
      const service = new ConversationContextService(testDatabaseUrl ?? "", {
        execute,
      } as unknown as AiRoutingService);
      const database = new Client({ connectionString: testDatabaseUrl });
      await database.connect();
      try {
        const trigger = await service.enqueueForMessage({
          provider: "bluebubbles",
          providerChatId: chatGuid,
          providerMessageId:
            envelopes.at(-1)?.message.providerMessageId ?? "missing",
          routeId,
          baseMessageWindow: 2,
          redundancyMessageWindow: 1,
          includeFromMe: true,
          timeZone: "UTC",
          summaryPolicyVersion: 1,
        });
        const sourceCompressionId = trigger.compressionOperationId;
        expect(sourceCompressionId).toBeDefined();
        await service.processQueued(routeId, "UTC", `source-${randomUUID()}`);

        execute.mockResolvedValueOnce({
          ...successfulResult,
          text: "Regenerated fictional summary",
        });
        const regeneration = await service.regenerateCompression(
          sourceCompressionId ?? "",
        );
        expect(regeneration.status).toBe("created");
        if (regeneration.status !== "created") return;
        await expect(
          service.regenerateCompression(sourceCompressionId ?? ""),
        ).resolves.toEqual({ status: "active", id: regeneration.id });

        await service.processQueued(routeId, "UTC", `preview-${randomUUID()}`);
        const lastCall = execute.mock.calls.at(-1)?.[0] as
          { messages: Array<{ content: string }> } | undefined;
        const prompt = lastCall?.messages;
        expect(prompt?.[1]?.content).toContain(
          "<previous_summary>\n\n</previous_summary>",
        );
        expect(prompt?.[1]?.content).toContain("Fictional message 1");

        const result = await database.query<{
          preview_status: string;
          output_summary: string;
          source_compression_id: string;
          state_summary: string;
          state_version: number;
          covered_through_index: string;
          state_status: string;
          succeeded_events: string;
        }>(
          `SELECT preview.status AS preview_status, preview.output_summary,
                  preview.source_compression_id,
                  state.summary AS state_summary, state.version AS state_version,
                  state.covered_through_index::text, state.status AS state_status,
                  (SELECT COUNT(*)::text
                   FROM conversation_context_compression_events event
                   WHERE event.compression_id = preview.id
                     AND event.status = 'succeeded') AS succeeded_events
           FROM conversation_context_compressions preview
           INNER JOIN conversation_context_states state
             ON state.id = preview.context_state_id
           WHERE preview.id = $1`,
          [regeneration.id],
        );
        expect(result.rows[0]).toMatchObject({
          preview_status: "succeeded",
          output_summary: "Regenerated fictional summary",
          source_compression_id: sourceCompressionId,
          state_summary: "Merged fictional summary",
          state_version: 2,
          covered_through_index: "1",
          state_status: "idle",
          succeeded_events: "1",
        });
      } finally {
        await database.end();
        await service.close();
      }
    });

    it("never reads a legacy workflow summary as the current chat summary", async () => {
      const chatGuid = `iMessage;-;summary-legacy-${randomUUID()}`;
      const envelopes = await archiveMessages(chatGuid, 1);
      const service = new ConversationContextService(testDatabaseUrl ?? "", {
        execute,
      } as unknown as AiRoutingService);
      const database = new Client({ connectionString: testDatabaseUrl });
      await database.connect();
      try {
        const providerMessageId =
          envelopes[0]?.message.providerMessageId ?? "missing";
        const initial = await service.snapshotForMessage({
          provider: "bluebubbles",
          providerChatId: chatGuid,
          providerMessageId,
          includeFromMe: true,
          timeZone: "UTC",
          summaryPolicyVersion: 1,
        });
        await database.query(
          `UPDATE conversation_context_states
           SET instance_namespace = 'legacy:' || id::text,
               legacy = TRUE,
               summary = 'Legacy workflow summary must not be read',
               covered_through_index = 1,
               version = 2
           WHERE id = $1`,
          [initial.summarySnapshot.stateId],
        );

        const current = await service.snapshotForMessage({
          provider: "bluebubbles",
          providerChatId: chatGuid,
          providerMessageId,
          includeFromMe: true,
          timeZone: "UTC",
          summaryPolicyVersion: 1,
        });

        expect(current.summarySnapshot).toMatchObject({
          summary: "",
          summaryVersion: 1,
          coveredThroughIndex: "0",
        });
        expect(current.summarySnapshot.stateId).not.toBe(
          initial.summarySnapshot.stateId,
        );
      } finally {
        await database.end();
        await service.close();
      }
    });
  },
);
