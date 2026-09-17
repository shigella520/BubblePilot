import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import {
  ConversationContextService,
  type ConversationContextSnapshot,
} from "../modules/workflow/conversation-context-service.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";
const url = process.env.TEST_DATABASE_URL;
const settings = {
  includeFromMe: true,
  baseMessageWindow: 3,
  redundancyMessageWindow: 2,
  characterLimit: 6000,
};
describe.runIf(!!url)("raw context PostgreSQL windows", () => {
  let archive: PostgresArchiveRepository,
    service: ConversationContextService,
    db: Pool;
  beforeAll(() => {
    archive = new PostgresArchiveRepository(url!);
    service = new ConversationContextService(url!);
    db = new Pool({ connectionString: url });
  });
  afterAll(async () => {
    await Promise.all([archive.close(), service.close(), db.end()]);
  });
  async function fixture(count: number) {
    const chatGuid = `iMessage;-;fictional-window-${randomUUID()}`;
    const adapter = new BlueBubblesWebhookAdapter();
    for (let i = 1; i <= count; i++) {
      const normalized = adapter.normalize(
        newMessageWebhook({
          chatGuid,
          messageGuid: `${chatGuid}-${i}`,
          text: `Fictional message ${i}`,
        }),
        randomUUID(),
      );
      if (normalized.kind !== "message") throw new Error("fixture");
      await archive.ingestMessage(normalized.envelope, true);
    }
    return {
      chatGuid,
      snapshot: async (i: number, override = settings, version = 1) =>
        (
          await service.snapshotForMessage({
            provider: "bluebubbles",
            providerChatId: chatGuid,
            providerMessageId: `${chatGuid}-${i}`,
            settings: override,
            settingsVersion: version,
          })
        ).contextSnapshot,
      load: (i: number, snapshot?: ConversationContextSnapshot) =>
        service.load({
          executionId: null,
          provider: "bluebubbles",
          providerChatId: chatGuid,
          beforeProviderMessageId: `${chatGuid}-${i}`,
          settings,
          settingsVersion: 1,
          contextSnapshot: snapshot ?? null,
        }),
    };
  }
  it("keeps prefixes until threshold, survives restart and isolates later triggers", async () => {
    const f = await fixture(12);
    const a = await f.snapshot(4),
      b = await f.snapshot(5),
      c = await f.snapshot(6);
    expect(a.afterMessageIndex).toBe("0");
    expect(b.afterMessageIndex).toBe("0");
    expect(c.afterMessageIndex).toBe("2");
    expect((await f.load(5, b)).messages.map((m) => m.body)).toEqual(
      [1, 2, 3, 4].map((i) => `Fictional message ${i}`),
    );
    expect((await f.load(6, c)).messages.map((m) => m.body)).toEqual(
      [3, 4, 5].map((i) => `Fictional message ${i}`),
    );
    await f.snapshot(12);
    const restarted = new ConversationContextService(url!);
    try {
      const repeated = await restarted.snapshotForMessage({
        provider: "bluebubbles",
        providerChatId: f.chatGuid,
        providerMessageId: `${f.chatGuid}-5`,
        settings: { ...settings, baseMessageWindow: 1 },
        settingsVersion: 99,
      });
      expect(repeated.contextSnapshot).toEqual(b);
    } finally {
      await restarted.close();
    }
    expect((await f.load(4, a)).messages).toHaveLength(3);
  });
  it("initializes old history at B, freezes config and serializes duplicate triggers", async () => {
    const f = await fixture(30);
    const snapshots = await Promise.all([
      f.snapshot(20),
      f.snapshot(20),
      f.snapshot(20),
    ]);
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[0]?.afterMessageIndex).toBe("16");
    const changed = await f.snapshot(
      25,
      { ...settings, baseMessageWindow: 2 },
      2,
    );
    expect((await f.load(25, changed)).messages).toHaveLength(2);
    expect((await f.load(20, snapshots[0])).messages).toHaveLength(3);
    const count = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM conversation_context_windows WHERE chat_id=$1 AND trigger_message_index=20",
      [changed.chatId],
    );
    expect(count.rows[0]?.n).toBe(1);
  });
  it("counts actual rows, preserves delayed timestamps, filters self and redacted records", async () => {
    const f = await fixture(12);
    const a = await f.snapshot(4);
    await db.query(
      "UPDATE messages SET body=NULL,attachments='[]',link_previews='[]',link_preview_status='redacted',content_redacted_at=now() WHERE chat_id=$1 AND message_index=4",
      [a.chatId],
    );
    await db.query(
      "UPDATE messages SET is_from_me=TRUE WHERE chat_id=$1 AND message_index=5",
      [a.chatId],
    );
    await db.query(
      "UPDATE messages SET sent_at='2020-01-01Z' WHERE chat_id=$1 AND message_index=10",
      [a.chatId],
    );
    const s = await f.snapshot(12, { ...settings, includeFromMe: false });
    const result = await f.load(12, s);
    expect(result.messages.map((m) => m.body)).toEqual(
      [9, 10, 11].map((i) => `Fictional message ${i}`),
    );
    expect(result.historyCoverage.retained?.earliestSentAt).toBe(
      "2020-01-01T00:00:00.000Z",
    );
    expect(result.historyCoverage.windowEvicted?.count).toBe(6);
    expect(result.historyCoverage.omitted).toBeNull();
    await db.query("UPDATE chats SET enabled=FALSE WHERE id=$1", [a.chatId]);
    await expect(f.load(12, s)).rejects.toThrow(/authorization/);
  });
  it("reports character trimming separately and retains one oversized message", async () => {
    const f = await fixture(7);
    const s = await f.snapshot(7, { ...settings, characterLimit: 100 });
    await db.query(
      "UPDATE messages SET body=repeat('x',200) WHERE chat_id=$1 AND message_index=6",
      [s.chatId],
    );
    const result = await f.load(7, s);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.body).toHaveLength(200);
    expect(result.historyCoverage.omitted?.count).toBe(2);
    expect(result.historyCoverage.windowEvicted?.count).toBe(3);
    expect(result.contextIncompleteReasons).toEqual([
      "window-evicted",
      "history-trimmed",
      "character-overflow",
    ]);
  });
  it("rejects cross-chat snapshots and handles an empty compatibility execution", async () => {
    const f = await fixture(1),
      other = await fixture(2);
    const snapshot = await other.snapshot(2);
    await expect(f.load(1, snapshot)).rejects.toThrow(/authorization/);
    const result = await f.load(1);
    expect(result.messages).toEqual([]);
    expect(result.contextIncomplete).toBe(false);
    expect(result.contextSnapshot.compatibilityInitialized).toBe(true);
  });
  it("retires summary storage without removing image or vector tables", async () => {
    for (const name of [
      "conversation_summary_settings",
      "conversation_context_states",
      "conversation_context_compressions",
    ]) {
      expect(
        (
          await db.query<{ name: string | null }>(
            "SELECT to_regclass($1) AS name",
            [name],
          )
        ).rows[0]?.name,
      ).toBeNull();
    }
    for (const name of [
      "messages",
      "message_image_summaries",
      "memory_chunks",
      "memory_generations",
      "message_bot_attributions",
    ]) {
      expect(
        (
          await db.query<{ name: string | null }>(
            "SELECT to_regclass($1) AS name",
            [name],
          )
        ).rows[0]?.name,
      ).toBe(name);
    }
  });
});
