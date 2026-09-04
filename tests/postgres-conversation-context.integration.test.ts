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
               ('conversation_context_compressions', 'execution_id'),
               ('workflow_versions', 'needs_resave')
             )`,
        );
        expect(columns.rows).toEqual([]);
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
