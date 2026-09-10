import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
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
    ).toBeLessThanOrEqual(6000);
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
