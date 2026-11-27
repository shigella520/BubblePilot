import { randomUUID } from "node:crypto";
import { memoryEmbeddingsDdl } from "../modules/memory/memory-embeddings-ddl.js";
import { readFile, readdir } from "node:fs/promises";
import { Client, Pool } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import { ConversationContextService } from "../modules/workflow/conversation-context-service.js";
import { ChatImageSourceRepository } from "../modules/ai/chat-image-source.js";
import { MemoryRepository } from "../modules/memory/memory-repository.js";
import { defaultMemoryConfig } from "../modules/memory/memory-types.js";
import {
  chatMessageQuerySchema,
  chatCountQuerySchema,
  chatExtremaQuerySchema,
} from "../modules/memory/chat-query-types.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";

const url = process.env.TEST_DATABASE_URL;
const settings = {
  includeFromMe: true,
  baseMessageWindow: 3,
  redundancyMessageWindow: 2,
  characterLimit: 6000,
};
describe.runIf(!!url)(
  "sent-time history boundaries (isolated PostgreSQL)",
  () => {
    const name = `sent_time_${randomUUID().replaceAll("-", "")}_test`;
    let admin: Client,
      db: Pool,
      archive: PostgresArchiveRepository,
      context: ConversationContextService,
      memory: MemoryRepository;
    let connection: string;
    beforeAll(async () => {
      admin = new Client({ connectionString: url });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}"`);
      const address = new URL(url!);
      address.pathname = `/${name}`;
      connection = address.toString();
      db = new Pool({ connectionString: connection });
      for (const file of (
        await readdir(new URL("../migrations/", import.meta.url))
      )
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await db.query(
          await readFile(
            new URL(`../migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
      await db.query("CREATE EXTENSION vector");
      for (const statement of memoryEmbeddingsDdl) await db.query(statement);
      archive = new PostgresArchiveRepository(connection);
      context = new ConversationContextService(connection);
      memory = new MemoryRepository(connection, "fictional-sent-time-key");
      await memory.saveSettings(
        { ...defaultMemoryConfig, dimensions: 2 },
        true,
        (await memory.settings()).version,
        undefined,
        "fixture-v1",
      );
    }, 30000);
    afterAll(async () => {
      await Promise.all([
        archive?.close(),
        context?.close(),
        memory?.close(),
        db?.end(),
      ]);
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
        await admin.end();
      }
    });
    async function fixture() {
      const chat = `fictional-late-${randomUUID()}`;
      async function send(text: string, seconds: number, attachment = false) {
        const guid = randomUUID();
        const payload = newMessageWebhook({
          chatGuid: chat,
          messageGuid: guid,
          text,
          dateCreated: Date.parse("2026-01-01T00:00:00Z") + seconds * 1000,
        });
        const normalized = new BlueBubblesWebhookAdapter().normalize(
          payload,
          randomUUID(),
        );
        if (normalized.kind !== "message") throw new Error("fixture");
        if (attachment)
          normalized.envelope.message.attachments = [
            {
              providerAttachmentId: `fictional-${guid}`,
              mimeType: "image/png",
              fileName: "fictional.png",
              sizeBytes: 4,
            },
          ];
        const result = await archive.ingestMessage(normalized.envelope, true);
        return { guid, id: result.messageId! };
      }
      const earlier = await send("Fictional earlier", 1);
      const trigger = await send("Fictional question", 20);
      const snapshot = (
        await context.snapshotForMessage({
          provider: "bluebubbles",
          providerChatId: chat,
          providerMessageId: trigger.guid,
          settings,
          settingsVersion: 1,
        })
      ).contextSnapshot;
      const w = randomUUID(),
        v = randomUUID(),
        t = randomUUID(),
        execution = randomUUID();
      await db.query(
        "INSERT INTO workflows(id,name,status) VALUES($1,'fictional','draft')",
        [w],
      );
      await db.query(
        "INSERT INTO workflow_versions(id,workflow_id,version,status,definition) VALUES($1,$2,1,'draft','{}')",
        [v, w],
      );
      await db.query(
        "INSERT INTO bot_triggers(id,name,workflow_version_id,conditions) VALUES($1,'fictional',$2,'{}')",
        [t, v],
      );
      await db.query(
        "INSERT INTO workflow_executions(id,provider,external_event_id,source_message_id,trigger_id,workflow_version_id,correlation_id,status) VALUES($1::uuid,'bluebubbles',$1::text,$2,$3,$4,$1::uuid,'created')",
        [execution, trigger.id, t, v],
      );
      await memory.authorize(snapshot.chatId, true, 0);
      const scope = {
        provider: "bluebubbles",
        providerChatId: chat,
        triggerMessageId: trigger.guid,
        executionId: execution,
      };
      const load = () =>
        context.load({
          executionId: execution,
          provider: "bluebubbles",
          providerChatId: chat,
          beforeProviderMessageId: trigger.guid,
          settings,
          settingsVersion: 1,
          contextSnapshot: snapshot,
        });
      return { send, earlier, trigger, snapshot, execution, scope, load };
    }
    it("includes late earlier images, excludes later and equal-time late messages, and freezes across restart", async () => {
      const f = await fixture();
      const image = await f.send("Fictional late picture", 10, true);
      const future = await f.send("Fictional future", 30, true);
      const equal = await f.send("Fictional same-time late", 20, true);
      const loaded = await f.load();
      expect(loaded.messages.map((m) => m.providerMessageId)).toEqual([
        f.earlier.guid,
        image.guid,
      ]);
      expect(loaded.contextSnapshot.contract).toBe("raw-context-v2");
      const sources = new ChatImageSourceRepository(db);
      expect(
        await sources.resolve(f.scope, image.guid, 0, false),
      ).not.toBeNull();
      expect(
        await sources.resolve(f.scope, image.guid, 0, true),
      ).not.toBeNull();
      expect(await sources.authorized(f.scope, future.guid, false)).toBe(false);
      expect(await sources.authorized(f.scope, equal.guid, false)).toBe(false);
      const tooLate = await f.send("Fictional after freeze", 5, true);
      expect(await sources.authorized(f.scope, tooLate.guid, false)).toBe(
        false,
      );
      const restarted = new ConversationContextService(connection);
      try {
        const retry = await restarted.load({
          executionId: f.execution,
          provider: "bluebubbles",
          providerChatId: f.scope.providerChatId,
          beforeProviderMessageId: f.trigger.guid,
          settings: { ...settings, baseMessageWindow: 1 },
          settingsVersion: 99,
        });
        expect(retry.contextSnapshot).toEqual(loaded.contextSnapshot);
        expect(retry.messages.map((m) => m.providerMessageId)).toEqual(
          loaded.messages.map((m) => m.providerMessageId),
        );
      } finally {
        await restarted.close();
      }
      await db.query(
        "UPDATE messages SET content_redacted_at=now(),body=NULL,attachments='[]' WHERE id=$1",
        [image.id],
      );
      expect((await f.load()).messages.map((m) => m.providerMessageId)).toEqual(
        [f.earlier.guid],
      );
      expect(await sources.resolve(f.scope, image.guid, 0, false)).toBeNull();
      await db.query("UPDATE chats SET enabled=false WHERE id=$1", [
        f.snapshot.chatId,
      ]);
      await expect(f.load()).rejects.toThrow(/authorization/);
    });
    it("shares the frozen boundary with raw queries, counts, extrema and retrieval", async () => {
      const f = await fixture();
      const image = await f.send("Fictional searchable late picture", 10, true);
      const future = await f.send("Fictional searchable future", 30, true);
      await f.load();
      await f.send("Fictional searchable after freeze", 5, true);
      const scope = (await memory.scopeForEvent(
        "bluebubbles",
        f.trigger.guid,
        f.execution,
      ))!;
      expect(scope.sentTimeBoundary).toBe(true);
      const page = await memory.archiveQueries.query(
        scope,
        chatMessageQuerySchema.parse({ order: "asc", limit: 50 }),
        "UTC",
      );
      expect(page.rows.map((r) => r.message.id)).toEqual([
        f.earlier.id,
        image.id,
      ]);
      const count = await memory.archiveQueries.aggregate(
        scope,
        chatCountQuerySchema.parse({ groupBy: "none" }),
        "UTC",
      );
      expect(count.totalCount).toBe(2);
      const last = await memory.archiveQueries.aggregate(
        scope,
        chatExtremaQuerySchema.parse({ pick: "last", groupBy: "none" }),
        "UTC",
      );
      expect(last.rows[0]?.message?.message.id).toBe(image.id);
      expect(
        (await memory.unindexed(scope, { query: "searchable" })).map(
          (m) => m.id,
        ),
      ).toEqual([image.id]);
      expect((await memory.coverage(scope)).total).toBe(2);
      const around = await memory.surrounding(scope, 1, 1, 0, 20);
      expect(around.after.map((m) => m.id)).toEqual([image.id]);
      // Even a retained message quoting a future message must not disclose it.
      await db.query(
        "UPDATE messages SET reply_target_guid=$2,reply_part='0' WHERE id=$1",
        [image.id, future.guid],
      );
      const quoted = await memory.archiveQueries.query(
        scope,
        chatMessageQuerySchema.parse({ order: "asc" }),
        "UTC",
      );
      expect(quoted.rows.at(-1)?.message.replyTo?.status).toBe("unavailable");
    });
    it("keeps legacy executions on their original boundary", async () => {
      const f = await fixture();
      await db.query(
        "UPDATE workflow_executions SET history_boundary=NULL WHERE id=$1",
        [f.execution],
      );
      const image = await f.send("Fictional legacy late image", 10, true);
      expect((await f.load()).contextSnapshot.contract).toBe("raw-context-v1");
      expect((await f.load()).messages.map((m) => m.providerMessageId)).toEqual(
        [f.earlier.guid],
      );
      expect(
        await new ChatImageSourceRepository(db).authorized(
          f.scope,
          image.guid,
          false,
        ),
      ).toBe(false);
    });
    it("serializes concurrent freezes and keeps each execution independent", async () => {
      const f = await fixture();
      await f.send("Fictional late", 10);
      const results = await Promise.all([f.load(), f.load(), f.load()]);
      expect(results[1]?.contextSnapshot).toEqual(results[0]?.contextSnapshot);
      expect(results[2]?.contextSnapshot).toEqual(results[0]?.contextSnapshot);
      const another = await fixture();
      await another.send("Fictional other", 10);
      expect(
        (await another.load()).messages.every(
          (m) =>
            !results[0]?.messages.some(
              (r) => r.providerMessageId === m.providerMessageId,
            ),
        ),
      ).toBe(true);
    });
  },
);
