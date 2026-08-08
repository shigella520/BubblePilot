import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(testDatabaseUrl !== undefined)(
  "PostgresArchiveRepository",
  () => {
    let repository: PostgresArchiveRepository;

    beforeAll(() => {
      repository = new PostgresArchiveRepository(testDatabaseUrl ?? "");
    });

    afterAll(async () => {
      await repository.close();
    });

    it("persists a message atomically and rejects the duplicate event", async () => {
      const suffix = randomUUID();
      const adapter = new BlueBubblesWebhookAdapter();
      const normalized = adapter.normalize(
        newMessageWebhook({
          messageGuid: `fake-message-${suffix}`,
          chatGuid: `iMessage;-;fake-chat-${suffix}`,
        }),
        randomUUID(),
      );
      expect(normalized.kind).toBe("message");
      if (normalized.kind !== "message") {
        return;
      }

      const first = await repository.ingestMessage(normalized.envelope, true);
      const recorded = await repository.recordAutomationOutcome(
        normalized.envelope.provider,
        normalized.envelope.eventId,
        "matched",
      );
      const duplicate = await repository.ingestMessage(
        normalized.envelope,
        true,
      );
      const events = await repository.listInboundEvents({
        limit: 100,
        cursor: null,
      });
      const event = events.find(
        (candidate) => candidate.eventId === normalized.envelope.eventId,
      );
      const chats = await repository.listChats({ limit: 100, cursor: null });
      const chat = chats.find((candidate) =>
        candidate.providerChatId.endsWith(suffix),
      );

      expect(first.status).toBe("archived");
      expect(first.automationOutcome).toBe("evaluation-pending");
      expect(recorded).toBe("matched");
      expect(duplicate.status).toBe("duplicate");
      expect(duplicate.automationOutcome).toBe("matched");
      expect(event).toMatchObject({
        eventType: "new-message",
        ingestionStatus: "completed",
        automationOutcome: "matched",
      });
      expect(chat?.messageCount).toBe(1);

      const messages = await repository.listMessages(chat?.id ?? randomUUID(), {
        limit: 100,
        cursor: null,
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.providerMessageId).toBe(`fake-message-${suffix}`);

      const mapped = await repository.saveChatParticipantIdentities({
        chatId: chat?.id ?? randomUUID(),
        expectedVersion: 1,
        identities: [
          {
            senderId: "fictional-user@example.test",
            realName: "林一",
            nickname: "队长",
          },
        ],
      });
      expect(mapped).toMatchObject({
        status: "ok",
        value: {
          version: 2,
          participants: [
            {
              senderId: "fictional-user@example.test",
              realName: "林一",
              nickname: "队长",
              messageCount: 1,
            },
          ],
        },
      });
      await expect(
        repository.resolveParticipantIdentities(
          normalized.envelope.chat.providerChatId,
          ["fictional-user@example.test", "not-present@example.test"],
        ),
      ).resolves.toEqual([
        {
          senderId: "fictional-user@example.test",
          realName: "林一",
          nickname: "队长",
        },
      ]);
      await expect(
        repository.saveChatParticipantIdentities({
          chatId: chat?.id ?? randomUUID(),
          expectedVersion: 2,
          identities: [
            {
              senderId: "not-present@example.test",
              realName: "未知成员",
              nickname: null,
            },
          ],
        }),
      ).resolves.toMatchObject({ status: "invalid-sender" });
    });

    it("redacts expired content only after automation is final and audits it", async () => {
      const suffix = randomUUID();
      const adapter = new BlueBubblesWebhookAdapter();
      const normalized = adapter.normalize(
        newMessageWebhook({
          messageGuid: `fictional-retention-message-${suffix}`,
          chatGuid: `iMessage;-;fictional-retention-chat-${suffix}`,
          text: "Fictional content that should expire.",
        }),
        randomUUID(),
      );
      expect(normalized.kind).toBe("message");
      if (normalized.kind !== "message") return;

      const ingested = await repository.ingestMessage(
        normalized.envelope,
        true,
      );
      const database = new Client({ connectionString: testDatabaseUrl });
      await database.connect();
      const now = new Date();
      const before = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1_000);
      const correlationId = randomUUID();
      const exportId = randomUUID();
      try {
        await database.query(
          "UPDATE messages SET created_at = $2 WHERE id = $1",
          [
            ingested.messageId,
            new Date(now.getTime() - 100 * 24 * 60 * 60 * 1_000),
          ],
        );
        await expect(
          repository.redactExpiredMessageContent({
            before,
            now,
            limit: 100,
            retentionDays: 90,
            correlationId,
          }),
        ).resolves.toBe(0);

        await repository.recordAutomationOutcome(
          normalized.envelope.provider,
          normalized.envelope.eventId,
          "no-active-triggers",
        );
        await database.query(
          `INSERT INTO data_export_jobs (
             id, actor_type, actor_session_id, chat_id, sent_from, sent_to,
             include_messages, include_executions, snapshot_at, message_count,
             execution_count, estimated_bytes, status, expires_at
           ) SELECT
             $2, 'api-token', NULL, chat_id, sent_at - INTERVAL '1 second',
             sent_at + INTERVAL '1 second', TRUE, FALSE, $3, 1, 0, 1024,
             'awaiting-confirmation', $4
           FROM messages WHERE id = $1`,
          [
            ingested.messageId,
            exportId,
            now,
            new Date(now.getTime() + 5 * 60 * 1_000),
          ],
        );
        await expect(
          repository.redactExpiredMessageContent({
            before,
            now,
            limit: 100,
            retentionDays: 90,
            correlationId,
          }),
        ).resolves.toBe(0);
        await database.query(
          `UPDATE data_export_jobs
           SET status = 'revoked', revoked_at = $2
           WHERE id = $1`,
          [exportId, now],
        );
        await expect(
          repository.redactExpiredMessageContent({
            before,
            now,
            limit: 100,
            retentionDays: 90,
            correlationId,
          }),
        ).resolves.toBe(1);

        const stored = await database.query<{
          body: string | null;
          attachments: unknown;
          content_redacted_at: Date | null;
        }>(
          `SELECT body, attachments, content_redacted_at
           FROM messages WHERE id = $1`,
          [ingested.messageId],
        );
        expect(stored.rows[0]).toMatchObject({
          body: null,
          attachments: [],
          content_redacted_at: now,
        });
        const audit = await database.query<{ metadata: unknown }>(
          `SELECT metadata FROM audit_events
           WHERE correlation_id = $1
             AND action = 'message.content.retention'`,
          [correlationId],
        );
        expect(audit.rows).toEqual([
          {
            metadata: {
              retentionDays: 90,
              cutoffAt: before.toISOString(),
              redactedCount: 1,
            },
          },
        ]);
      } finally {
        await database.end();
      }
    });
  },
);
