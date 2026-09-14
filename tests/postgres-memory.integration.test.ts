import { BotIdentityService } from "../modules/identity/bot-identity-service.js";
import {
  chatMessageQuerySchema,
  chatCountQuerySchema,
  chatExtremaQuerySchema,
} from "../modules/memory/chat-query-types.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { MemoryRepository } from "../modules/memory/memory-repository.js";
import { MemoryService } from "../modules/memory/memory-service.js";
import { defaultMemoryConfig } from "../modules/memory/memory-types.js";
import type { EmbeddingClient } from "../modules/memory/embedding-client.js";
const url = process.env.TEST_DATABASE_URL;
describe.runIf(!!url)("PostgreSQL memory lifecycle", () => {
  let repo: MemoryRepository;
  let service: MemoryService;
  let generationId: string;
  const config = { ...defaultMemoryConfig, dimensions: 2 };
  const embedding: EmbeddingClient = {
    identity: () => Promise.resolve("fixture-v1"),
    encode: (_c, _s, texts) =>
      Promise.resolve(texts.map((t) => (t.includes("备份") ? [1, 0] : [0, 1]))),
  };
  beforeAll(async () => {
    repo = new MemoryRepository(url ?? "", "fictional-memory-encryption-key");
    service = new MemoryService(repo, embedding);
    expect(await repo.ready()).toBe(true);
    const current = await repo.settings();
    await repo.saveSettings(
      config,
      true,
      current.version,
      undefined,
      "fixture-v1",
    );
    generationId = (await repo.generations()).find(
      (g) => g.status === "active",
    )!.id;
  });
  afterAll(async () => {
    await repo.pool.query("UPDATE memory_settings SET enabled=FALSE");
    await repo.close();
  });
  async function chat() {
    const id = randomUUID();
    await repo.pool.query(
      "INSERT INTO chats(id,provider,provider_chat_id,type,enabled) VALUES($1::uuid,'bluebubbles',$1::text,'group',TRUE)",
      [id],
    );
    await repo.authorize(id, true, 0);
    return id;
  }
  async function message(chatId: string, body: string) {
    const event = randomUUID(),
      id = randomUUID();
    await repo.pool.query(
      "INSERT INTO inbound_events(id,provider,external_event_id,correlation_id,event_type,status,payload_hash) VALUES($1::uuid,'bluebubbles',$1::text,$1::uuid,'message','accepted','fictional')",
      [event],
    );
    await repo.pool.query(
      "INSERT INTO messages(id,provider,provider_message_id,chat_id,sender_id,sent_at,body,content_type,is_from_me,content_hash,source_event_id) VALUES($1::uuid,'bluebubbles',$1::text,$2,'fictional-sender',now(),$3,'text',FALSE,'fixture',$4)",
      [id, chatId, body, event],
    );
    return id;
  }

  it("uses a single raw filtering contract for exact counts, extrema and microsecond pages", async () => {
    const id = await chat();
    const records = [];
    for (const [timestamp, sender, body] of [
      ["2026-09-10T21:59:59.999999Z", "alice", "Backup 100% _ Backup"],
      ["2026-09-10T22:00:00.000001Z", "alice", "Backup 100% _"],
      ["2026-09-10T22:00:00.000002Z", "alice", "backup 100% _"],
      ["2026-09-10T22:00:00.000002Z", "bob", "backup"],
      ["2026-09-11T16:00:00Z", "alice", "archive only"],
      ["2026-09-09T23:00:00Z", "alice", "Backup 100% _"],
    ]) {
      const mid = await message(id, body!);
      await repo.pool.query(
        "UPDATE messages SET sent_at=$2,sender_id=$3 WHERE id=$1",
        [mid, timestamp, sender],
      );
      records.push(mid);
    }
    const trigger = await message(id, "trigger");
    await message(id, "backup 100% _");
    await message(await chat(), "backup 100% _");
    const scope = (await repo.scopeForEvent(
      "bluebubbles",
      trigger,
      randomUUID(),
      "Asia/Shanghai",
    ))!;
    const filters = {
      senderId: "alice",
      from: "2026-09-10T00:00:00+08:00",
      to: "2026-09-13T00:00:00+08:00",
      dailyTime: { from: "06:00", to: "24:00" },
      keywords: ["BACKUP", "100%", "_"],
      keywordMode: "all" as const,
    };
    const all = await repo.archiveQueries.query(
      scope,
      chatMessageQuerySchema.parse({ ...filters, order: "asc" }),
      scope.timeZone!,
    );
    expect(all.rows.map((r) => r.message.id)).toEqual([
      records[5],
      records[1],
      records[2],
    ]);
    expect(all.rows[1]?.position.sentAt).toBe("2026-09-10T22:00:00.000001Z");
    const secondPage = await repo.archiveQueries.query(
      scope,
      chatMessageQuerySchema.parse({ ...filters, order: "asc", limit: 1 }),
      scope.timeZone!,
      all.rows[1]!.position,
    );
    expect(secondPage.rows.map((r) => r.message.id)).toEqual([records[2]]);
    const counts = await repo.archiveQueries.aggregate(
      scope,
      chatCountQuerySchema.parse({ ...filters, groupBy: "day", limit: 1 }),
      scope.timeZone!,
    );
    expect(counts.rows.map((r) => [r.key, r.count])).toEqual([
      ["2026-09-10", 1],
      ["2026-09-11", 2],
    ]);
    const total = await repo.archiveQueries.aggregate(
      scope,
      chatCountQuerySchema.parse(filters),
      scope.timeZone!,
    );
    expect(total.rows[0]?.count).toBe(3);
    const extrema = await repo.archiveQueries.aggregate(
      scope,
      chatExtremaQuerySchema.parse({
        ...filters,
        groupBy: "day",
        pick: "first",
      }),
      scope.timeZone!,
    );
    expect(extrema.rows.map((r) => r.message?.message.id ?? null)).toEqual([
      records[5],
      records[1],
      null,
      null,
    ]);
    const any = await repo.archiveQueries.aggregate(
      scope,
      chatCountQuerySchema.parse({
        keywords: ["archive", "BACKUP"],
        keywordMode: "any",
      }),
      "UTC",
    );
    expect(any.rows[0]?.count).toBe(6);
    await repo.pool.query(
      "UPDATE messages SET content_redacted_at=now() WHERE id=$1",
      [records[1]],
    );
    const cleaned = await repo.archiveQueries.aggregate(
      scope,
      chatCountQuerySchema.parse(filters),
      scope.timeZone!,
    );
    expect(cleaned.rows[0]?.count).toBe(2);
  });
  it("returns empty local dates, separate unknown senders and overnight/DST matches", async () => {
    const id = await chat();
    const a = await message(id, "fictional night");
    const b = await message(id, "fictional night");
    await repo.pool.query(
      "UPDATE messages SET sent_at='2026-11-01T05:30:00Z',sender_id=NULL WHERE id=$1",
      [a],
    );
    await repo.pool.query(
      "UPDATE messages SET sent_at='2026-11-01T06:30:00Z',sender_id='unknown' WHERE id=$1",
      [b],
    );
    const scope = (await repo.scope(id, 999, null))!;
    const filter = {
      from: "2026-11-01T00:00:00-04:00",
      to: "2026-11-02T23:59:59-05:00",
      dailyTime: { from: "23:00", to: "02:00" },
    };
    const result = await repo.archiveQueries.aggregate(
      scope,
      chatCountQuerySchema.parse({ ...filter, groupBy: "day" }),
      "America/New_York",
    );
    expect(result.rows.map((r) => r.count)).toEqual([2, 0]);
    const senders = await repo.archiveQueries.aggregate(
      scope,
      chatCountQuerySchema.parse({ ...filter, groupBy: "sender" }),
      "America/New_York",
    );
    expect(senders.rows.map((r) => [r.senderId, r.count])).toEqual([
      [null, 1],
      ["unknown", 1],
    ]);
    const last = await repo.archiveQueries.aggregate(
      scope,
      chatExtremaQuerySchema.parse({ ...filter, pick: "last" }),
      "America/New_York",
    );
    expect(last.rows[0]?.message?.message.id).toBe(b);
  });
  it("binds session cursors, fits actual returned pages and expands extrema sources offline", async () => {
    const id = await chat();
    for (let i = 0; i < 4; i++)
      await message(id, "fictional body " + i + "x".repeat(100));
    const scope = {
      ...(await repo.scope(id, 999, null))!,
      timeZone: "Asia/Shanghai",
    };
    const offline = new MemoryService(repo, {
      identity: () => Promise.reject(new Error("offline")),
      encode: () => Promise.reject(new Error("offline")),
    });
    const session = await offline.session(scope);
    const execute = async (name: string, args: unknown, maximum = 24000) =>
      JSON.parse(
        await session.execute(name, JSON.stringify(args), {
          signal: new AbortController().signal,
          deadline: Date.now() + 60000,
          maxOutputCharacters: maximum,
        }),
      ) as {
        status: string;
        reason?: string;
        nextCursor: string | null;
        hasMore: boolean;
        truncated: boolean;
        count?: number;
        evidence: { messageId: string; ref: string }[];
        groups: { message: { ref: string } | null }[];
      };
    const first = await execute(
      "query_chat_messages",
      { order: "asc", limit: 4 },
      1250,
    );
    expect(first.status).toBe("succeeded");
    expect(first.truncated).toBe(true);
    expect(first.hasMore).toBe(true);
    const next = await execute("query_chat_messages", {
      order: "asc",
      limit: 4,
      cursor: first.nextCursor,
    });
    expect(
      new Set([...first.evidence, ...next.evidence].map((r) => r.messageId))
        .size,
    ).toBe(4);
    expect(
      (
        await execute("query_chat_messages", {
          order: "desc",
          cursor: first.nextCursor,
        })
      ).reason,
    ).toBe("invalid-cursor");
    expect(
      (await execute("query_chat_messages", { cursor: randomUUID() })).reason,
    ).toBe("invalid-cursor");
    const repeated = await execute("query_chat_messages", {
      order: "asc",
      limit: 1,
    });
    expect(repeated.evidence[0]?.ref).toBe(first.evidence[0]?.ref);
    const extrema = await execute("get_chat_message_extrema", {
      pick: "first",
    });
    const expanded = await execute("read_chat_excerpt", {
      ref: extrema.groups[0]!.message!.ref,
    });
    expect(expanded.status).toBe("succeeded");
    expect(
      (await execute("count_chat_messages", { senderId: "absent" })).count,
    ).toBe(0);
    await repo.authorize(id, false, 1);
    expect((await execute("count_chat_messages", {})).status).toBe(
      "unavailable",
    );
  });

  it("pages exact count groups after content fitting and never turns failures into zeros", async () => {
    const id = await chat();
    await message(id, "fixture");
    const session = await service.session({
      ...(await repo.scope(id, 999, null))!,
      timeZone: "UTC",
    });
    const args = {
      groupBy: "day",
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-31T23:59:59Z",
    };
    const invoke = async (input: unknown, maximum = 24000) =>
      JSON.parse(
        await session.execute("count_chat_messages", JSON.stringify(input), {
          signal: new AbortController().signal,
          deadline: Date.now() + 60000,
          maxOutputCharacters: maximum,
        }),
      ) as {
        status: string;
        count?: number;
        groups: { date: string; count: number }[];
        nextCursor: string | null;
        hasMore: boolean;
        truncated: boolean;
      };
    const first = await invoke(args, 1000);
    expect(first.truncated).toBe(true);
    const second = await invoke({ ...args, cursor: first.nextCursor });
    expect(
      new Set([...first.groups, ...second.groups].map((g) => g.date)).size,
    ).toBe(31);
    expect(
      [...first.groups, ...second.groups].every((g) => g.count === 0),
    ).toBe(true);
    expect(session.references()).toEqual([]);
    const spy = vi
      .spyOn(repo.archiveQueries, "aggregate")
      .mockRejectedValueOnce(new Error("fictional query failure"));
    expect(await invoke({})).toEqual({
      status: "unavailable",
      reason: "invalid-or-unavailable",
    });
    spy.mockRestore();
    const other = await service.session((await repo.scope(id, 999, null))!);
    expect(
      JSON.parse(
        await other.execute(
          "count_chat_messages",
          JSON.stringify({ ...args, cursor: first.nextCursor }),
        ),
      ),
    ).toMatchObject({ status: "unavailable", reason: "invalid-cursor" });
  });
  it("cancels raw SQL with the remaining shared duration and discards late query evidence", async () => {
    const id = await chat();
    await message(id, "fictional cancellable source");
    const scope = (await repo.scope(id, 999, null))!;
    const controller = new AbortController();
    controller.abort();
    await expect(
      repo.archiveQueries.query(
        scope,
        chatMessageQuerySchema.parse({}),
        "UTC",
        undefined,
        {
          signal: controller.signal,
          deadline: Date.now() + 1000,
          maxOutputCharacters: 24000,
        },
      ),
    ).rejects.toThrow();
    const session = await service.session(scope);
    const original = repo.archiveQueries.query.bind(repo.archiveQueries);
    const delayed = vi
      .spyOn(repo.archiveQueries, "query")
      .mockImplementation(async (...args) => {
        const result = await original(...args);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return result;
      });
    await expect(
      session.execute("query_chat_messages", "{}", {
        signal: new AbortController().signal,
        deadline: Date.now() + 10,
        maxOutputCharacters: 24000,
      }),
    ).rejects.toThrow();
    expect(session.references()).toEqual([]);
    delayed.mockRestore();
  });
  it("queries event-time order with sender, time and trigger boundaries without indexing", async () => {
    const id = await chat();
    const old = await message(id, "虚构旧话题：备份备份");
    const latest = await message(id, "虚构最新发言");
    const delayed = await message(id, "虚构延迟归档");
    const trigger = await message(id, "虚构触发");
    await message(id, "虚构未来消息");
    await message(await chat(), "虚构其他聊天");
    await repo.pool.query(
      "UPDATE messages SET sent_at='2026-09-10T16:00:00Z' WHERE id=ANY($1::uuid[])",
      [[old, latest]],
    );
    await repo.pool.query(
      "UPDATE messages SET sent_at='2026-09-09T00:00:00Z' WHERE id=$1",
      [delayed],
    );
    const boundary = await repo.pool.query<{ message_index: string }>(
      "SELECT message_index FROM messages WHERE id=$1",
      [trigger],
    );
    const scope = (await repo.scope(
      id,
      Number(boundary.rows[0]!.message_index),
      null,
    ))!;
    const rows = await repo.latest(scope, {
      limit: 20,
      senderId: "fictional-sender",
      from: "2026-09-11T00:00:00+08:00",
      to: "2026-09-11T00:00:00+08:00",
    });
    expect(rows.map((m) => m.id)).toEqual([latest, old]);
    expect((await repo.latest(scope, { limit: 20 })).map((m) => m.id)).toEqual([
      latest,
      old,
      delayed,
    ]);
    expect(
      await repo.latest(scope, { limit: 20, senderId: "other@example.test" }),
    ).toEqual([]);
    await repo.pool.query(
      "UPDATE messages SET content_redacted_at=now() WHERE id=$1",
      [latest],
    );
    expect((await repo.latest(scope, { limit: 1 }))[0]?.id).toBe(old);
  });
  it("reuses sources beyond the old search/read quotas and validates every repeat", async () => {
    const id = await chat();
    await message(id, "虚构备份计划");
    await drain();
    const session = await service.session((await repo.scope(id, 999, null))!);
    for (let i = 0; i < 4; i++) {
      const result = await session.search({ query: "备份" });
      expect(result.evidence[0]?.ref).toBe("M1");
    }
    for (let i = 0; i < 4; i++)
      expect(
        JSON.parse(await session.execute("read_chat_excerpt", '{"ref":"M1"}')),
      ).toMatchObject({ status: "succeeded", evidence: [{ ref: "M1" }] });
    const count = await repo.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memory_retrieval_sources WHERE retrieval_id=$1",
      [session.id],
    );
    expect(count.rows[0]!.n).toBe(1);
    await repo.authorize(id, false, 1);
    expect(
      JSON.parse(await session.execute("get_latest_chat_messages", "{}")),
    ).toMatchObject({ status: "unavailable" });
  });
  it("isolates a cancelled query's late result without persisting or registering sources", async () => {
    const id = await chat();
    await message(id, "虚构迟到结果");
    const scope = (await repo.scope(id, 999, null))!;
    const rows = await repo.latest(scope, { limit: 1 });
    const session = await service.session(scope);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(repo, "latest").mockImplementationOnce(async () => {
      entered();
      await blocked;
      return rows;
    });
    const controller = new AbortController();
    try {
      const pending = session.execute("get_latest_chat_messages", "{}", {
        signal: controller.signal,
        deadline: Date.now() + 5000,
        maxOutputCharacters: 24000,
      });
      await ready;
      controller.abort();
      release();
      await expect(pending).rejects.toThrow();
      expect(session.references()).toEqual([]);
      expect(
        (
          await repo.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM memory_retrieval_sources WHERE retrieval_id=$1",
            [session.id],
          )
        ).rows[0]!.n,
      ).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
  it("rolls back source writes when cancellation interrupts an open transaction", async () => {
    const id = await chat();
    await message(id, "虚构取消中的来源");
    const session = await service.session((await repo.scope(id, 999, null))!);
    const controller = new AbortController();
    await repo.pool.query(
      "CREATE OR REPLACE FUNCTION agent_fixture_delay_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$",
    );
    await repo.pool.query(
      `CREATE TRIGGER agent_fixture_delay_source BEFORE INSERT ON memory_retrieval_sources FOR EACH ROW WHEN (NEW.retrieval_id = '${session.id}') EXECUTE FUNCTION agent_fixture_delay_source()`,
    );
    try {
      const pending = session.execute("get_latest_chat_messages", "{}", {
        signal: controller.signal,
        deadline: Date.now() + 5000,
        maxOutputCharacters: 24000,
      });
      const assertion = expect(pending).rejects.toThrow();
      let waiting = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const state = await repo.pool.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE 'INSERT INTO memory_retrieval_sources%') AS waiting",
        );
        if (state.rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort();
      await assertion;
      expect(waiting).toBe(true);
      expect(session.references()).toEqual([]);
      expect(
        (
          await repo.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM memory_retrieval_sources WHERE retrieval_id=$1",
            [session.id],
          )
        ).rows[0]?.n,
      ).toBe(0);
    } finally {
      controller.abort();
      await repo.pool.query(
        "DROP TRIGGER IF EXISTS agent_fixture_delay_source ON memory_retrieval_sources",
      );
      await repo.pool.query(
        "DROP FUNCTION IF EXISTS agent_fixture_delay_source()",
      );
    }
  });
  it("only commits references that fit the serialized result, and marks oversized messages unavailable", async () => {
    const id = await chat();
    await message(id, "虚构大消息".repeat(3000));
    await message(id, "虚构小消息");
    const session = await service.session((await repo.scope(id, 999, null))!);
    const context = {
      signal: new AbortController().signal,
      deadline: Date.now() + 5000,
      maxOutputCharacters: 4000,
    };
    const result = JSON.parse(
      await session.execute(
        "get_latest_chat_messages",
        '{"limit":20}',
        context,
      ),
    ) as { evidence: unknown[] };
    expect(result).toMatchObject({
      status: "succeeded",
      truncated: true,
      evidence: [{ ref: "M1" }],
    });
    expect(result.evidence).toHaveLength(1);
    expect(session.references()).toEqual(["M1"]);
    expect(
      (
        await repo.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM memory_retrieval_sources WHERE retrieval_id=$1",
          [session.id],
        )
      ).rows[0]!.n,
    ).toBe(1);
    const tiny = JSON.parse(
      await session.execute("get_latest_chat_messages", "{}", {
        ...context,
        maxOutputCharacters: 1,
      }),
    ) as unknown;
    expect(tiny).toMatchObject({
      status: "unavailable",
      reason: "tool-output",
      truncated: true,
    });
  });
  async function drain() {
    await repo.pool.query(
      "UPDATE memory_jobs SET next_attempt_at=now() WHERE status='queued'",
    );
    for (let i = 0; i < 10; i++) await service.work();
  }
  it("transactionally queues, indexes and retrieves same-chat evidence", async () => {
    const id = await chat();
    await message(id, "虚构讨论：决定使用旧电脑进行备份。");
    await message(id, "同意，暂时不购买 NAS。");
    await drain();
    const scope = await repo.scope(id, 999, null);
    expect(scope).not.toBeNull();
    const session = await service.session(scope!);
    const result = await session.search({ query: "备份" });
    expect(result.status).toBe("succeeded");
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.coverage.indexed).toBe(2);
    expect(session.render("决定使用旧电脑 [M1]")).toBe("决定使用旧电脑");
    expect(session.render("这件事还没找到线索，你记得大概哪天吗？")).toBe(
      "这件事还没找到线索，你记得大概哪天吗？",
    );
    expect(session.render("不存在的来源 [M999]")).toBeNull();
    const other = await chat();
    const otherSession = await service.session(
      (await repo.scope(other, 999, null))!,
    );
    expect(
      (
        JSON.parse(
          await otherSession.execute("read_chat_excerpt", '{"ref":"M1"}'),
        ) as { status: string }
      ).status,
    ).toBe("unavailable");
  });
  it("invalidates text, vectors visibility and cached evidence on redaction", async () => {
    const id = await chat();
    const source = await message(id, "虚构备份计划");
    await drain();
    const scope = (await repo.scope(id, 999, null))!;
    const session = await service.session(scope);
    expect(
      (await session.search({ query: "备份" })).evidence.length,
    ).toBeGreaterThan(0);
    await repo.pool.query(
      "UPDATE messages SET body=NULL,content_redacted_at=now() WHERE id=$1",
      [source],
    );
    expect(await session.validate()).toBe(false);
    const chunks = await repo.pool.query<{
      text: string | null;
      valid: boolean;
    }>("SELECT text,valid FROM memory_chunks WHERE chat_id=$1", [id]);
    expect(chunks.rows.every((c) => c.text === null && !c.valid)).toBe(true);
    expect(await repo.candidates(scope, { query: "备份" }, [1, 0])).toEqual([]);
  });
  it("excludes chunks spanning the triggering event and enforces chat disable", async () => {
    const id = await chat();
    await message(id, "之前讨论备份");
    await message(id, "此后改为取消备份");
    await drain();
    const scope = (await repo.scope(id, 2, null))!;
    expect(await repo.candidates(scope, { query: "备份" }, [1, 0])).toEqual([]);
    await repo.pool.query("UPDATE chats SET enabled=FALSE WHERE id=$1", [id]);
    expect(await repo.allowed(scope)).toBe(false);
  });
  it("reindexes retained neighbors when a shared chunk source changes", async () => {
    const id = await chat();
    const first = await message(id, "虚构备份原方案");
    await message(id, "虚构备份配套说明");
    await drain();
    await repo.pool.query(
      "UPDATE messages SET body='虚构备份修订方案' WHERE id=$1",
      [first],
    );
    expect((await repo.chatView(id)).coverage).toMatchObject({
      total: 2,
      indexed: 0,
    });
    await drain();
    expect((await repo.chatView(id)).coverage).toMatchObject({
      total: 2,
      indexed: 2,
    });
  });
  it("preserves coverage while global retrieval is disabled", async () => {
    const id = await chat();
    await message(id, "虚构覆盖状态");
    await drain();
    await repo.pool.query("UPDATE memory_settings SET enabled=FALSE");
    try {
      expect(await repo.scope(id, 100, null)).toBeNull();
      expect((await repo.chatView(id)).coverage).toMatchObject({
        total: 1,
        indexed: 1,
      });
    } finally {
      await repo.pool.query("UPDATE memory_settings SET enabled=TRUE");
    }
  });
  it("supports idempotent backfill and versioned pause/resume/cancel", async () => {
    const id = await chat();
    await message(id, "虚构任务");
    const key = randomUUID();
    const job = await repo.createJob(
      id,
      generationId,
      undefined,
      undefined,
      key,
    );
    expect(
      (await repo.createJob(id, generationId, undefined, undefined, key))?.id,
    ).toBe(job?.id);
    await expect(
      repo.createJob(id, generationId, "2025-01-01T00:00:00Z", undefined, key),
    ).rejects.toMatchObject({ code: "MEMORY_REQUEST_CONFLICT" });
    await repo.action(job!.id, "pause", 1);
    await expect(repo.action(job!.id, "resume", 1)).rejects.toThrow("Refresh");
    await repo.action(job!.id, "resume", 2);
    await repo.action(job!.id, "cancel", 3);
  });
  it("recovers expired leases and rejects source changes before publication", async () => {
    await drain();
    const id = await chat();
    const messageId = await message(id, "虚构租约测试");
    await repo.pool.query(
      "UPDATE memory_jobs SET next_attempt_at=now() WHERE chat_id=$1",
      [id],
    );
    const first = (await repo.claim())!;
    expect(first.chat_id).toBe(id);
    const originals = await repo.messages(id, 1, 10);
    await repo.pool.query(
      "UPDATE memory_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [first.id],
    );
    const recovered = (await repo.claim())!;
    expect(recovered.id).toBe(first.id);
    expect(recovered.lease_owner).not.toBe(first.lease_owner);
    await repo.publish(first, [], [], []);
    expect((await repo.jobs(id)).find((j) => j.id === first.id)?.status).toBe(
      "running",
    );
    await repo.pool.query(
      "UPDATE messages SET body='虚构内容已更正' WHERE id=$1",
      [messageId],
    );
    await expect(repo.publish(recovered, originals, [], [])).rejects.toThrow(
      "MEMORY_SOURCE_CHANGED",
    );
    await repo.fail(recovered, "MEMORY_SOURCE_CHANGED");
    await drain();
  });
  it("does not publish after a source change or a cancelled lease", async () => {
    const id = await chat();
    await message(id, "虚构原始备份");
    await repo.pool.query(
      "UPDATE memory_jobs SET next_attempt_at=now() WHERE chat_id=$1",
      [id],
    );
    const job = await repo.claim();
    expect(job).not.toBeNull();
    if (!job) return;
    await repo.pool.query(
      "UPDATE memory_jobs SET status='cancelled',lease_owner=NULL WHERE id=$1",
      [job.id],
    );
    await repo.publish(job, [], [], []);
    expect(
      (await repo.jobs(job.chat_id)).find((j) => j.id === job.id)?.status,
    ).toBe("cancelled");
  });
  it("keeps bounded submessage sources and applies participant names only to returned evidence", async () => {
    const id = await chat();
    await repo.pool.query(
      "INSERT INTO chat_participant_identities(id,chat_id,sender_id,nickname) VALUES($1,$2,'fictional-sender','虚构昵称')",
      [randomUUID(), id],
    );
    await message(id, "虚构备份计划。".repeat(1500));
    await drain();
    const session = await service.session((await repo.scope(id, 999, null))!);
    const result = await session.search({ query: "备份" });
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(
      result.evidence.reduce((n, e) => n + e.text.length, 0),
    ).toBeLessThanOrEqual(24000);
    expect(session.render("原计划 [M1]")).toBe("原计划");
    expect(
      JSON.parse(session.render('{"answer":"原计划 [M1]"}', "json")!) as {
        answer: string;
      },
    ).toHaveProperty("answer");
    expect(
      JSON.parse(session.render('{"answer":"原计划 [M1]"}', "json")!),
    ).toEqual({ answer: "原计划" });
  });
  it("reports partial keyword evidence before indexing without advancing coverage", async () => {
    const id = await chat();
    await message(id, "虚构未索引的精确标识 DEMO-PENDING-42");
    const session = await service.session((await repo.scope(id, 999, null))!);
    const result = await session.search({ query: "DEMO-PENDING-42" });
    expect(result.status).toBe("partial");
    expect(result.evidence.length).toBe(1);
    expect(result.coverage.indexed).toBe(0);
  });
  it("keeps historical backfill within its explicit sent-time range", async () => {
    const id = await chat();
    const a = await message(id, "虚构范围内备份");
    const outside = await message(id, "虚构范围外内容");
    const b = await message(id, "虚构范围内结论");
    await repo.pool.query(
      "UPDATE memory_jobs SET status='cancelled' WHERE chat_id=$1",
      [id],
    );
    await repo.pool.query(
      "UPDATE messages SET sent_at='2026-01-10T00:00:00Z' WHERE id=ANY($1::uuid[])",
      [[a, b]],
    );
    await repo.pool.query(
      "UPDATE messages SET sent_at='2025-01-10T00:00:00Z' WHERE id=$1",
      [outside],
    );
    await repo.createJob(
      id,
      generationId,
      "2026-01-01T00:00:00Z",
      "2026-01-31T23:59:59Z",
      randomUUID(),
    );
    await drain();
    expect(
      (
        await repo.pool.query(
          "SELECT 1 FROM memory_indexed_messages WHERE message_id=$1",
          [outside],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await repo.pool.query(
          "SELECT 1 FROM memory_indexed_messages WHERE message_id=ANY($1::uuid[])",
          [[a, b]],
        )
      ).rowCount,
    ).toBe(2);
  });
  it("counts fixed task membership and cleanup without cursor arithmetic", async () => {
    await drain();
    const id = await chat();
    const first = await message(id, "虚构短消息");
    const removed = await message(id, "虚构待清理消息");
    await message(id, "虚构长消息".repeat(500));
    await repo.pool.query(
      "UPDATE memory_jobs SET status='cancelled' WHERE chat_id=$1",
      [id],
    );
    const task = await repo.createJob(
      id,
      generationId,
      undefined,
      undefined,
      randomUUID(),
    );
    if (!task) throw new Error("Expected fixture task");
    const before = (await repo.jobs(id)).find((j) => j.id === task.id)!;
    expect(before.progress).toMatchObject({
      scope: "full",
      total: 3,
      processed: 0,
      percent: 0,
    });
    await repo.pool.query(
      "UPDATE messages SET body=NULL,content_redacted_at=now() WHERE id=$1",
      [removed],
    );
    await drain();
    const after = (await repo.jobs(id)).find((j) => j.id === task.id)!;
    expect(after.status).toBe("succeeded");
    expect(after.progress).toMatchObject({
      total: 3,
      processed: 2,
      removed: 1,
      remaining: 0,
      percent: 100,
    });
    expect(after.progress.estimate.status).toBe("succeeded");
    // A later retention change cannot rewrite historical completed work.
    await repo.pool.query(
      "UPDATE messages SET body=NULL,content_redacted_at=now() WHERE id=$1",
      [first],
    );
    expect(
      (await repo.jobs(id)).find((j) => j.id === task.id)!.progress.processed,
    ).toBe(2);
  });
  it("tracks role rebuild membership, samples, estimates and preserves its kind across batches", async () => {
    await drain();
    const id = await chat();
    for (let i = 0; i < 4; i++) await message(id, "虚构重建消息".repeat(10));
    const identity = new BotIdentityService(url!);
    try {
      await identity.rebuild(
        id,
        {
          enabled: true,
          providerRouteId: randomUUID(),
          includeFromMe: true,
          timeZone: "UTC",
        },
        "memory",
      );
    } finally {
      await identity.close();
    }
    let claimed = (await repo.claim())!;
    expect(claimed.chat_id).toBe(id);
    expect(claimed.request_key).toBeNull();
    const taskId = claimed.id;
    expect(
      (await repo.jobs(id)).find((j) => j.id === taskId)!.progress,
    ).toMatchObject({ scope: "full", total: 4, processed: 0 });
    for (let i = 0; i < 3; i++) {
      await repo.pool.query(
        "UPDATE memory_jobs SET progress_started_at=now()-interval '6 seconds',progress_last_at=now()-interval '6 seconds' WHERE id=$1",
        [taskId],
      );
      const batch = (
        await repo.messages(
          id,
          Number(claimed.cursor_index) + 1,
          Number(claimed.through_index),
        )
      ).slice(0, 1);
      await repo.publish(claimed, batch, [], [], batch[0]!.index);
      const state = (await repo.jobs(id)).find((j) => j.id === taskId)!;
      expect(state.reason).toBe("rebuild");
      expect(state.progress.processed).toBe(i + 1);
      if (i === 2) {
        expect(state.progress.estimate.status).toBe("available");
        expect(state.progress.estimate.messagesPerMinute).toBeGreaterThan(0);
        expect(state.progress.estimate.remainingSeconds).toBeGreaterThan(0);
      }
      claimed = (await repo.claim())!;
      expect(claimed.id).toBe(taskId);
    }
    await repo.fail(claimed, "FICTIONAL_RETRY");
    expect((await repo.jobs(id)).find((j) => j.id === taskId)!.reason).toBe(
      "rebuild",
    );
    await repo.pool.query(
      "UPDATE memory_jobs SET next_attempt_at=now() WHERE id=$1",
      [taskId],
    );
    claimed = (await repo.claim())!;
    const state = (await repo.jobs(id)).find((j) => j.id === taskId)!;
    await repo.action(taskId, "pause", state.version);
    const paused = (await repo.jobs(id)).find((j) => j.id === taskId)!;
    await repo.action(taskId, "resume", paused.version);
    await drain();
    const finished = (await repo.jobs(id)).find((j) => j.id === taskId)!;
    expect(finished.reason).toBe("rebuild");
    expect(finished.progress).toMatchObject({
      total: 4,
      processed: 4,
      percent: 100,
    });
  });
  it("recovers unkeyed legacy rebuild progress without reprocessing its completed prefix", async () => {
    await drain();
    const id = await chat();
    await message(id, "虚构已完成消息");
    await message(id, "虚构剩余消息");
    await repo.pool.query(
      "UPDATE memory_jobs SET status='cancelled' WHERE chat_id=$1",
      [id],
    );
    const task = (
      await repo.pool.query<{ id: string }>(
        "INSERT INTO memory_jobs(chat_id,generation_id,reason,from_index,through_index,cursor_index,progress_samples) VALUES($1,$2,'backfill',1,2,1,$3) RETURNING id",
        [
          id,
          generationId,
          JSON.stringify([
            {
              at: Date.now(),
              milliseconds: 20000,
              characters: 100,
              messages: 0,
            },
          ]),
        ],
      )
    ).rows[0]!;
    const claimed = (await repo.claim())!;
    expect(claimed.id).toBe(task.id);
    expect(claimed.cursor_index).toBe("1");
    expect(claimed.progress_samples).toEqual([]);
    expect(
      (await repo.jobs(id)).find((j) => j.id === task.id)!.progress,
    ).toMatchObject({ scope: "remaining", total: 1, processed: 0 });
    const batch = await repo.messages(id, 2, 2);
    await repo.publish(claimed, batch, [], [], 2);
    expect(
      (await repo.jobs(id)).find((j) => j.id === task.id)!.progress,
    ).toMatchObject({ scope: "remaining", processed: 1, percent: 100 });
  });
  it("initializes old tasks from their remaining range and rejects stale lease progress", async () => {
    await drain();
    const id = await chat();
    await message(id, "虚构升级前消息");
    await message(id, "虚构升级后消息");
    await repo.pool.query(
      "UPDATE memory_jobs SET status='cancelled' WHERE chat_id=$1",
      [id],
    );
    const task = await repo.createJob(
      id,
      generationId,
      undefined,
      undefined,
      randomUUID(),
    );
    if (!task) throw new Error("Expected fixture task");
    await repo.pool.query("DELETE FROM memory_job_items WHERE job_id=$1", [
      task.id,
    ]);
    await repo.pool.query(
      "UPDATE memory_jobs SET progress_scope=NULL,cursor_index=from_index WHERE id=$1",
      [task.id],
    );
    const claimed = await repo.claim();
    expect(claimed?.id).toBe(task.id);
    let state = (await repo.jobs(id)).find((j) => j.id === task.id)!;
    expect(state.progress).toMatchObject({
      scope: "remaining",
      total: 1,
      processed: 0,
    });
    const messages = await repo.messages(
      id,
      Number(claimed!.cursor_index) + 1,
      Number(claimed!.through_index),
    );
    await repo.action(task.id, "pause", state.version);
    await repo.publish(
      claimed!,
      messages,
      [],
      [],
      Number(claimed!.through_index),
    );
    state = (await repo.jobs(id)).find((j) => j.id === task.id)!;
    expect(state.progress.processed).toBe(0);
    expect(state.progress.estimate.status).toBe("paused");
    await repo.action(task.id, "resume", state.version);
    await drain();
    expect(
      (await repo.jobs(id)).find((j) => j.id === task.id)!.progress,
    ).toMatchObject({ total: 1, processed: 1, percent: 100 });
  });
  it("paginates all historical tasks with stable tied timestamps and reads off-page details", async () => {
    const id = await chat();
    await repo.pool.query(
      `INSERT INTO memory_jobs(chat_id,generation_id,reason,from_index,through_index,cursor_index,status,created_at)
      SELECT $1,$2,'backfill',1,1,1,'succeeded','2026-01-01T00:00:00.123456Z'::timestamptz FROM generate_series(1,125)`,
      [id, generationId],
    );
    const ids: string[] = [];
    let cursor: { timestamp: Date; id: string } | null = null;
    while (true) {
      const rows = await repo.jobs(id, { limit: 26, cursor });
      const page = rows.slice(0, 25);
      ids.push(...page.map((j) => j.id));
      if (rows.length <= 25) break;
      const last = page.at(-1)!;
      cursor = { timestamp: last.created_at, id: last.id };
    }
    expect(ids.length).toBe(125);
    expect(new Set(ids).size).toBe(125);
    expect(
      (await repo.jobs(undefined, { limit: 1, id: ids[124]! }))[0]?.id,
    ).toBe(ids[124]);
    expect(await repo.jobs(await chat(), { limit: 1, id: ids[124]! })).toEqual(
      [],
    );
  });
});
