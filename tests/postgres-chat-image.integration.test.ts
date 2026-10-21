import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { ChatImageSourceRepository } from "../modules/ai/chat-image-source.js";
import { MemoryRepository } from "../modules/memory/memory-repository.js";
import { MemoryService } from "../modules/memory/memory-service.js";
import { defaultMemoryConfig } from "../modules/memory/memory-types.js";
const url = process.env.TEST_DATABASE_URL;
describe.runIf(!!url)("chat image archive authorization", () => {
  let pool: Pool;
  let admin: Pool;
  const databaseName = `bubblepilot_image_${randomUUID().replaceAll("-", "")}_test`;
  let sources: ChatImageSourceRepository;
  let memory: MemoryRepository;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const connection = new URL(url!);
    connection.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: connection.toString() });
    for (const file of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await pool.query(
        await readFile(
          new URL(`../migrations/${file}`, import.meta.url),
          "utf8",
        ),
      );
    await pool.query("CREATE EXTENSION vector");
    await pool.query(
      "CREATE TABLE memory_embeddings(chunk_id UUID PRIMARY KEY REFERENCES memory_chunks(id) ON DELETE CASCADE,dimensions INTEGER NOT NULL,embedding vector NOT NULL)",
    );
    sources = new ChatImageSourceRepository(pool);
    memory = new MemoryRepository(connection.toString(), "fictional-image-key");
    const current = await memory.settings();
    await memory.saveSettings(
      { ...defaultMemoryConfig, dimensions: 2 },
      true,
      current.version,
      undefined,
      "fictional-image-model",
    );
  });
  afterAll(async () => {
    await memory?.close();
    await pool?.end();
    // Pool.end() can resolve before sockets close; let PostgreSQL wait for disconnect
    // instead of forcibly terminating clients that are still shutting down.
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  });
  async function fixture() {
    const chatId = randomUUID();
    await pool.query(
      "INSERT INTO chats(id,provider,provider_chat_id,type,enabled) VALUES($1,'bluebubbles',$2,'group',true)",
      [chatId, chatId],
    );
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      ids.push(id);
      await pool.query(
        "INSERT INTO inbound_events(id,provider,external_event_id,correlation_id,event_type,status,payload_hash) VALUES($1,'bluebubbles',$2,$1,'message','accepted','fictional')",
        [id, id],
      );
      await pool.query(
        "INSERT INTO messages(id,provider,provider_message_id,chat_id,sender_id,sent_at,body,content_type,is_from_me,content_hash,source_event_id,attachments) VALUES($1,'bluebubbles',$2,$3,'fictional',now(),'虚构菜单价格未完整摘录','mixed',false,'fictional',$1,$4)",
        [
          id,
          id,
          chatId,
          JSON.stringify([
            {
              providerAttachmentId: `fictional-${i}`,
              fileName: "menu.png",
              mimeType: "image/png",
              sizeBytes: 50,
            },
          ]),
        ],
      );
    }
    return {
      chatId,
      ids,
      scope: {
        provider: "bluebubbles",
        providerChatId: chatId,
        triggerMessageId: ids[1]!,
      },
    };
  }
  it("allows trigger/window access but requires history permission and strict trigger boundary", async () => {
    const f = await fixture();
    expect(await sources.resolve(f.scope, f.ids[1]!, 0, false)).not.toBeNull();
    expect(await sources.resolve(f.scope, f.ids[0]!, 0, false)).not.toBeNull();
    expect(await sources.resolve(f.scope, f.ids[0]!, 0, true)).toBeNull();
    await memory.authorize(f.chatId, true, 0);
    expect(await sources.resolve(f.scope, f.ids[0]!, 0, true)).not.toBeNull();
    expect(await sources.resolve(f.scope, f.ids[1]!, 0, true)).toBeNull();
    expect(await sources.resolve(f.scope, f.ids[2]!, 0, false)).toBeNull();
    const another = await fixture();
    expect(
      await sources.resolve(another.scope, f.ids[0]!, 0, false),
    ).toBeNull();
    await pool.query(
      "UPDATE messages SET content_redacted_at=now() WHERE id=$1",
      [f.ids[0]],
    );
    expect(await sources.resolve(f.scope, f.ids[0]!, 0, false)).toBeNull();
  });
  it("exposes image refs only for accepted historical results and rechecks revoked permission", async () => {
    const f = await fixture();
    await memory.authorize(f.chatId, true, 0);
    const service = new MemoryService(memory);
    const eventScope = await memory.scopeForEvent(
      "bluebubbles",
      f.ids[1]!,
      randomUUID(),
    );
    const scope = eventScope ? { ...eventScope, executionId: null } : null;
    expect(scope).not.toBeNull();
    const session = await service.session(scope!);
    session.imagesEnabled = true;
    const result: unknown = JSON.parse(
      await session.execute(
        "query_chat_messages",
        JSON.stringify({ order: "asc", limit: 1 }),
      ),
    );
    expect(
      (result as { evidence: { images: unknown[] }[] }).evidence[0]!.images,
    ).toHaveLength(1);
    expect(session.imageCandidates()).toHaveLength(1);
    expect(session.imageCandidates()[0]?.providerMessageId).toBe(f.ids[0]);
    const bounded = await service.session(scope!);
    bounded.imagesEnabled = true;
    await bounded.execute(
      "query_chat_messages",
      JSON.stringify({ order: "asc", limit: 1 }),
      {
        signal: new AbortController().signal,
        deadline: Date.now() + 5000,
        maxOutputCharacters: 5,
      },
    );
    expect(bounded.imageCandidates()).toEqual([]);
    await pool.query("UPDATE memory_chats SET enabled=false WHERE chat_id=$1", [
      f.chatId,
    ]);
    expect(await sources.resolve(f.scope, f.ids[0]!, 0, true)).toBeNull();
    expect(await session.validate()).toBe(false);
  });
});
