import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DataExportService } from "../modules/export/export-service.js";
import { PostgresDataExportRepository } from "../modules/export/postgres-export-repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(testDatabaseUrl !== undefined)(
  "PostgresDataExportRepository",
  () => {
    let repository: PostgresDataExportRepository;
    let pool: Pool;

    beforeAll(() => {
      repository = new PostgresDataExportRepository(testDatabaseUrl ?? "");
      pool = new Pool({ connectionString: testDatabaseUrl });
    });

    afterAll(async () => {
      await repository.close();
      await pool.end();
    });

    it("freezes enabled-chat content, isolates owners, and omits private configuration", async () => {
      const suffix = randomUUID();
      const ids = {
        enabledChat: randomUUID(),
        disabledChat: randomUUID(),
        enabledEvent: randomUUID(),
        disabledEvent: randomUUID(),
        enabledMessage: randomUUID(),
        disabledMessage: randomUUID(),
        workflow: randomUUID(),
        workflowVersion: randomUUID(),
        trigger: randomUUID(),
        execution: randomUUID(),
        ownerSession: randomUUID(),
        otherSession: randomUUID(),
      };
      const sentAt = new Date("2026-08-03T08:00:00.000Z");
      let currentTime = new Date();
      const privatePrompt = `PRIVATE_PROMPT_${suffix}`;
      const privateSecretReference = `PRIVATE_SECRET_REF_${suffix}`;

      await pool.query(
        `INSERT INTO admin_sessions (
           id, token_hash, expires_at, last_seen_at
         ) VALUES
           ($1, $2, $3, $4),
           ($5, $6, $3, $4)`,
        [
          ids.ownerSession,
          `owner-token-${suffix}`,
          new Date(currentTime.getTime() + 60 * 60 * 1_000),
          currentTime,
          ids.otherSession,
          `other-token-${suffix}`,
        ],
      );
      await pool.query(
        `INSERT INTO chats (
           id, provider, provider_chat_id, type, display_name, enabled
         ) VALUES
           ($1, 'bluebubbles', $2, 'group', 'Enabled fixture', TRUE),
           ($3, 'bluebubbles', $4, 'group', 'Disabled fixture', FALSE)`,
        [
          ids.enabledChat,
          `iMessage;+;enabled-${suffix}`,
          ids.disabledChat,
          `iMessage;+;disabled-${suffix}`,
        ],
      );
      await pool.query(
        `INSERT INTO inbound_events (
           id, provider, external_event_id, correlation_id, event_type,
           status, payload_hash
         ) VALUES
           ($1, 'bluebubbles', $2, $3, 'new-message', 'completed', $4),
           ($5, 'bluebubbles', $6, $7, 'new-message', 'completed', $8)`,
        [
          ids.enabledEvent,
          `enabled-event-${suffix}`,
          randomUUID(),
          `enabled-hash-${suffix}`,
          ids.disabledEvent,
          `disabled-event-${suffix}`,
          randomUUID(),
          `disabled-hash-${suffix}`,
        ],
      );
      await pool.query(
        `INSERT INTO messages (
           id, provider, provider_message_id, chat_id, sender_id, sent_at,
           body, content_type, is_from_me, content_hash, attachments,
           source_event_id
         ) VALUES
           ($1, 'bluebubbles', $2, $3, 'fixture@example.test', $4,
            'Frozen fixture message', 'text', FALSE, $5, '[]'::jsonb, $6),
           ($7, 'bluebubbles', $8, $9, 'fixture@example.test', $4,
            'Disabled fixture message', 'text', FALSE, $10, '[]'::jsonb, $11)`,
        [
          ids.enabledMessage,
          `enabled-message-${suffix}`,
          ids.enabledChat,
          sentAt,
          `enabled-content-${suffix}`,
          ids.enabledEvent,
          ids.disabledMessage,
          `disabled-message-${suffix}`,
          ids.disabledChat,
          `disabled-content-${suffix}`,
          ids.disabledEvent,
        ],
      );
      await pool.query(
        `INSERT INTO workflows (id, name, status)
         VALUES ($1, $2, 'active')`,
        [ids.workflow, `Export fixture ${suffix}`],
      );
      await pool.query(
        `INSERT INTO workflow_versions (
           id, workflow_id, version, status, definition, published_at
         ) VALUES ($1, $2, 1, 'published', $3::jsonb, $4)`,
        [
          ids.workflowVersion,
          ids.workflow,
          JSON.stringify({
            schemaVersion: "1",
            systemPrompt: privatePrompt,
            secretRef: privateSecretReference,
          }),
          currentTime,
        ],
      );
      await pool.query(
        "UPDATE workflows SET published_version_id = $2 WHERE id = $1",
        [ids.workflow, ids.workflowVersion],
      );
      await pool.query(
        `INSERT INTO bot_triggers (
           id, name, workflow_version_id, conditions, enabled
         ) VALUES ($1, $2, $3, '{}'::jsonb, FALSE)`,
        [ids.trigger, `Export trigger ${suffix}`, ids.workflowVersion],
      );
      await pool.query(
        `INSERT INTO workflow_executions (
           id, provider, external_event_id, source_message_id, trigger_id,
           workflow_version_id, correlation_id, status, error_summary,
           started_at, completed_at
         ) VALUES (
           $1, 'bluebubbles', $2, $3, $4, $5, $6, 'succeeded', $7, $8, $8
         )`,
        [
          ids.execution,
          `execution-event-${suffix}`,
          ids.enabledMessage,
          ids.trigger,
          ids.workflowVersion,
          randomUUID(),
          privateSecretReference,
          currentTime,
        ],
      );

      // PostgreSQL supplies created_at from its own clock. Capture the export
      // snapshot only after all fixtures have been committed so clock skew or
      // a few milliseconds of insertion time cannot exclude the fixtures.
      currentTime = new Date();

      const service = new DataExportService(repository, () => currentTime);
      const owner = {
        actorType: "session" as const,
        actorSessionId: ids.ownerSession,
      };
      const otherOwner = {
        actorType: "session" as const,
        actorSessionId: ids.otherSession,
      };
      const scope = {
        chatId: ids.enabledChat,
        sentFrom: "2026-08-03T00:00:00.000Z",
        sentTo: "2026-08-04T00:00:00.000Z",
        types: ["messages", "executions"] as const,
      };

      await expect(
        service.preview(owner, { ...scope, chatId: ids.disabledChat }),
      ).resolves.toEqual({ status: "scope-unavailable" });

      const preview = await service.preview(owner, scope);
      expect(preview).toMatchObject({
        status: "ok",
        value: { messageCount: 1, executionCount: 1, recordCount: 2 },
      });
      if (preview.status !== "ok") return;

      const lateEventId = randomUUID();
      const lateMessageId = randomUUID();
      await pool.query(
        `INSERT INTO inbound_events (
           id, provider, external_event_id, correlation_id, event_type,
           status, payload_hash
         ) VALUES ($1, 'bluebubbles', $2, $3, 'new-message', 'completed', $4)`,
        [
          lateEventId,
          `late-event-${suffix}`,
          randomUUID(),
          `late-hash-${suffix}`,
        ],
      );
      await pool.query(
        `INSERT INTO messages (
           id, provider, provider_message_id, chat_id, sender_id, sent_at,
           body, content_type, is_from_me, content_hash, attachments,
           source_event_id, created_at
         ) VALUES (
           $1, 'bluebubbles', $2, $3, 'fixture@example.test', $4,
           'Post-snapshot fixture message', 'text', FALSE, $5, '[]'::jsonb,
           $6, $7
         )`,
        [
          lateMessageId,
          `late-message-${suffix}`,
          ids.enabledChat,
          sentAt,
          `late-content-${suffix}`,
          lateEventId,
          new Date(currentTime.getTime() + 1_000),
        ],
      );

      await expect(
        service.list(otherOwner, { limit: 20, cursor: null }),
      ).resolves.toEqual([]);
      await expect(service.read(preview.value.id, otherOwner)).resolves.toEqual(
        {
          status: "not-found",
        },
      );

      const confirmed = await service.confirm(
        preview.value.id,
        owner,
        preview.value.recordCount,
        new Date(preview.value.snapshotAt),
      );
      expect(confirmed).toMatchObject({
        status: "ok",
        value: { status: "ready" },
      });
      const downloaded = await service.read(preview.value.id, owner);
      expect(downloaded).toMatchObject({
        status: "ok",
        content: {
          messages: [{ id: ids.enabledMessage }],
          executions: [{ id: ids.execution }],
        },
      });
      if (downloaded.status !== "ok") return;
      const body = service.render(downloaded);
      expect(body).toContain("Frozen fixture message");
      expect(body).not.toContain("Post-snapshot fixture message");
      expect(body).not.toContain(privatePrompt);
      expect(body).not.toContain(privateSecretReference);

      const revocable = await service.preview(owner, {
        ...scope,
        types: ["messages"],
      });
      if (revocable.status !== "ok") return;
      await expect(
        service.revoke(revocable.value.id, owner),
      ).resolves.toMatchObject({
        status: "ok",
        value: { status: "revoked" },
      });
      await expect(service.read(revocable.value.id, owner)).resolves.toEqual({
        status: "not-ready",
      });

      currentTime = new Date(currentTime.getTime() + 11 * 60 * 1_000);
      await expect(service.read(preview.value.id, owner)).resolves.toEqual({
        status: "expired",
      });
    });
  },
);
