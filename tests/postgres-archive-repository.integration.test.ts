import { randomUUID } from "node:crypto";

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
      const duplicate = await repository.ingestMessage(
        normalized.envelope,
        true,
      );
      const chats = await repository.listChats({ limit: 100, cursor: null });
      const chat = chats.find((candidate) =>
        candidate.providerChatId.endsWith(suffix),
      );

      expect(first.status).toBe("archived");
      expect(duplicate.status).toBe("duplicate");
      expect(chat?.messageCount).toBe(1);

      const messages = await repository.listMessages(chat?.id ?? randomUUID(), {
        limit: 100,
        cursor: null,
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.providerMessageId).toBe(`fake-message-${suffix}`);
    });
  },
);
