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
      const database = new Client({ connectionString: testDatabaseUrl });
      await database.connect();
      try {
        const indexed = await database.query<{ message_index: string }>(
          `SELECT message_index::text FROM messages WHERE id = $1`,
          [first.messageId],
        );
        expect(indexed.rows[0]?.message_index).toBe("1");
      } finally {
        await database.end();
      }

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

    it("allows only one concurrent pending link preview result to win", async () => {
      const suffix = randomUUID();
      const adapter = new BlueBubblesWebhookAdapter();
      const normalized = adapter.normalize(
        newMessageWebhook({
          messageGuid: `preview-race-${suffix}`,
          chatGuid: `iMessage;-;preview-race-chat-${suffix}`,
          text: "https://preview.example.test/race",
        }),
        randomUUID(),
      );
      expect(normalized.kind).toBe("message");
      if (normalized.kind !== "message") return;
      await repository.ingestMessage(normalized.envelope, true);
      const firstPreview = {
        status: "available" as const,
        errorCode: null,
        items: [
          {
            source: "open-graph" as const,
            url: "https://preview.example.test/race",
            originalUrl: null,
            title: "First stable result",
            summary: null,
            siteName: "Example Test",
            imageAvailable: false,
            imageUrl: null,
            imageSource: null,
            iconAvailable: false,
          },
        ],
      };
      const losingPreview = {
        status: "available" as const,
        errorCode: null,
        items: [
          {
            source: "open-graph" as const,
            url: "https://preview.example.test/race",
            originalUrl: null,
            title: "Losing overwrite",
            summary: null,
            siteName: "Example Test",
            imageAvailable: false,
            imageUrl: null,
            imageSource: null,
            iconAvailable: false,
          },
        ],
      };
      const [firstResult, secondResult] = await Promise.all([
        repository.saveMessageLinkPreview({
          providerMessageId: normalized.envelope.message.providerMessageId,
          linkPreview: firstPreview,
          diagnostics: [],
          fetchedAt: new Date(),
        }),
        repository.saveMessageLinkPreview({
          providerMessageId: normalized.envelope.message.providerMessageId,
          linkPreview: losingPreview,
          diagnostics: [],
          fetchedAt: new Date(),
        }),
      ]);
      expect(firstResult).toEqual(secondResult);
      expect([firstPreview, losingPreview]).toContainEqual(firstResult);
    });

    it("soft-deletes a disabled chat and rejects an enabled chat", async () => {
      const suffix = randomUUID();
      const adapter = new BlueBubblesWebhookAdapter();

      const disabledChat = `iMessage;-;delete-disabled-${suffix}`;
      const disabledNormalized = adapter.normalize(
        newMessageWebhook({
          messageGuid: `delete-disabled-message-${suffix}`,
          chatGuid: disabledChat,
        }),
        randomUUID(),
      );
      expect(disabledNormalized.kind).toBe("message");
      if (disabledNormalized.kind !== "message") return;
      await repository.ingestMessage(disabledNormalized.envelope, false);

      const monitoring = await repository.listChatMonitoring({
        limit: 100,
        cursor: null,
      });
      const disabled = monitoring.find((candidate) =>
        candidate.providerChatId.endsWith(suffix),
      );
      expect(disabled?.enabled).toBe(false);

      await expect(
        repository.deleteChat({
          chatId: disabled?.id ?? randomUUID(),
          expectedVersion: disabled?.version ?? 1,
        }),
      ).resolves.toEqual({ status: "deleted" });

      const afterDelete = await repository.listChatMonitoring({
        limit: 100,
        cursor: null,
      });
      expect(
        afterDelete.some((candidate) =>
          candidate.providerChatId.endsWith(suffix),
        ),
      ).toBe(false);

      const enabledChat = `iMessage;-;delete-enabled-${suffix}`;
      const enabledNormalized = adapter.normalize(
        newMessageWebhook({
          messageGuid: `delete-enabled-message-${suffix}`,
          chatGuid: enabledChat,
        }),
        randomUUID(),
      );
      expect(enabledNormalized.kind).toBe("message");
      if (enabledNormalized.kind !== "message") return;
      await repository.ingestMessage(enabledNormalized.envelope, true);
      const enabledMonitoring = await repository.listChatMonitoring({
        limit: 100,
        cursor: null,
      });
      const enabled = enabledMonitoring.find((candidate) =>
        candidate.providerChatId.endsWith(suffix),
      );
      await expect(
        repository.deleteChat({
          chatId: enabled?.id ?? randomUUID(),
          expectedVersion: enabled?.version ?? 1,
        }),
      ).resolves.toEqual({ status: "still-enabled" });
    });

    it("restores a soft-deleted chat when a new message arrives", async () => {
      const suffix = randomUUID();
      const adapter = new BlueBubblesWebhookAdapter();
      const chatGuid = `iMessage;-;restore-${suffix}`;

      const first = adapter.normalize(
        newMessageWebhook({
          messageGuid: `restore-one-${suffix}`,
          chatGuid,
        }),
        randomUUID(),
      );
      expect(first.kind).toBe("message");
      if (first.kind !== "message") return;
      await repository.ingestMessage(first.envelope, false);

      const monitoring = await repository.listChatMonitoring({
        limit: 100,
        cursor: null,
      });
      const chat = monitoring.find(
        (candidate) => candidate.providerChatId === chatGuid,
      );
      expect(chat?.enabled).toBe(false);
      await expect(
        repository.deleteChat({
          chatId: chat?.id ?? randomUUID(),
          expectedVersion: chat?.version ?? 1,
        }),
      ).resolves.toEqual({ status: "deleted" });

      const afterDelete = await repository.listChatMonitoring({
        limit: 100,
        cursor: null,
      });
      expect(
        afterDelete.some((candidate) => candidate.providerChatId === chatGuid),
      ).toBe(false);

      const second = adapter.normalize(
        newMessageWebhook({
          messageGuid: `restore-two-${suffix}`,
          chatGuid,
        }),
        randomUUID(),
      );
      expect(second.kind).toBe("message");
      if (second.kind !== "message") return;
      await repository.ingestMessage(second.envelope, false);

      const restored = await repository.listChatMonitoring({
        limit: 100,
        cursor: null,
      });
      const restoredChat = restored.find(
        (candidate) => candidate.providerChatId === chatGuid,
      );
      expect(restoredChat).toBeDefined();
      expect(restoredChat?.id).toBe(chat?.id);
      expect(restoredChat?.enabled).toBe(false);
    });

    it("freezes loaded context before the triggering message", async () => {
      const suffix = randomUUID();
      const adapter = new BlueBubblesWebhookAdapter();
      const chatGuid = `iMessage;-;context-boundary-${suffix}`;
      const messages = [
        {
          guid: `context-one-${suffix}`,
          text: "Fictional message one",
          at: 1_788_000_001_000,
        },
        {
          guid: `context-two-${suffix}`,
          text: "Fictional message two",
          at: 1_788_000_002_000,
        },
        {
          guid: `context-three-${suffix}`,
          text: "Fictional message three",
          at: 1_788_000_003_000,
        },
      ];
      for (const message of messages) {
        const normalized = adapter.normalize(
          newMessageWebhook({
            messageGuid: message.guid,
            chatGuid,
            text: message.text,
            dateCreated: message.at,
          }),
          randomUUID(),
        );
        expect(normalized.kind).toBe("message");
        if (normalized.kind === "message") {
          await repository.ingestMessage(normalized.envelope, true);
        }
      }

      await expect(
        repository.loadRecentMessages(chatGuid, {
          limit: 10,
          maxCharacters: 10_000,
          includeFromMe: true,
          beforeProviderMessageId: `context-two-${suffix}`,
        }),
      ).resolves.toMatchObject([
        {
          providerMessageId: `context-one-${suffix}`,
          body: "Fictional message one",
        },
      ]);
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
