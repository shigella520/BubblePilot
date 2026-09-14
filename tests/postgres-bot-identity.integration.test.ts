import { randomUUID } from "node:crypto";
import { afterAll, describe, it, expect } from "vitest";
import { BotIdentityService } from "../modules/identity/bot-identity-service.js";
import { ChatQueryRepository } from "../modules/memory/chat-query-repository.js";
import {
  chatCountQuerySchema,
  chatMessageQuerySchema,
} from "../modules/memory/chat-query-types.js";
import type { MemoryScope } from "../modules/memory/memory-types.js";
const url = process.env.TEST_DATABASE_URL;
describe.runIf(url)("Postgres Bot identity lifecycle", () => {
  const service = new BotIdentityService(url ?? "");
  const db = service.pool;
  const fixtureChats: string[] = [];
  afterAll(async () => {
    await db.query(
      "UPDATE conversation_context_compressions p SET status='superseded' FROM conversation_context_states s WHERE s.id=p.context_state_id AND s.chat_id=ANY($1::uuid[]) AND p.status IN ('queued','running')",
      [fixtureChats],
    );
    await db.query(
      "UPDATE chats SET bot_summary_rebuild_through=NULL WHERE id=ANY($1::uuid[])",
      [fixtureChats],
    );
    await service.close();
  });
  async function fixture() {
    const workflow = randomUUID(),
      version = randomUUID(),
      trigger = randomUUID(),
      chat = randomUUID(),
      event = randomUUID();
    await db.query(
      `INSERT INTO workflows(id,name,status) VALUES($1,'Fictional role','draft')`,
      [workflow],
    );
    await db.query(
      `INSERT INTO workflow_versions(id,workflow_id,version,status,definition) VALUES($1,$2,1,'validated','{}')`,
      [version, workflow],
    );
    await db.query(
      `INSERT INTO bot_triggers(id,name,workflow_version_id,conditions) VALUES($1,'fictional',$2,'{}')`,
      [trigger, version],
    );
    await db.query(
      `INSERT INTO chats(id,provider,provider_chat_id,type,enabled,next_message_index) VALUES($1::uuid,'bluebubbles',$1::text,'group',TRUE,100)`,
      [chat],
    );
    await db.query(
      `INSERT INTO inbound_events(id,provider,external_event_id,correlation_id,event_type,status,payload_hash) VALUES($1::uuid,'bluebubbles',$1::text,$1,'new-message','completed','fixture')`,
      [event],
    );
    fixtureChats.push(chat);
    async function execution() {
      const id = randomUUID();
      await db.query(
        `INSERT INTO workflow_executions(id,provider,external_event_id,trigger_id,workflow_version_id,correlation_id,status) VALUES($1::uuid,'bluebubbles',$1::text,$2,$3,$1,'created')`,
        [id, trigger, version],
      );
      return id;
    }
    async function message(index: number, guid = randomUUID()) {
      const id = randomUUID();
      await db.query(
        `INSERT INTO messages(id,provider,provider_message_id,chat_id,sent_at,body,content_type,is_from_me,content_hash,source_event_id,message_index) VALUES($1,'bluebubbles',$2,$3,'2026-01-01','fictional reply','text',TRUE,'fixture',$4,$5)`,
        [id, guid, chat, event, index],
      );
      return { id, guid };
    }
    async function delivery(executionId: string, guid: string | null) {
      const id = randomUUID();
      await db.query(
        `INSERT INTO outbound_deliveries(id,execution_id,node_id,idempotency_key,provider,provider_chat_id,body_hash,provider_temp_guid,provider_message_id,status) VALUES($1::uuid,$2,'reply',$1::text,'bluebubbles',$3,'fixture',$1,$4,'confirmed')`,
        [id, executionId, chat, guid],
      );
      return id;
    }
    async function link(mid: string) {
      const job = (
        await db.query<{ id: string }>(
          `SELECT id FROM bot_attribution_jobs WHERE message_id=$1 AND status='queued' ORDER BY created_at LIMIT 1`,
          [mid],
        )
      ).rows[0];
      expect(job).toBeDefined();
      await service.work(job!.id);
    }
    return {
      workflow,
      version,
      trigger,
      chat,
      execution,
      message,
      delivery,
      link,
    };
  }
  it("matches both arrival orders, preserves execution snapshots and first historical nickname", async () => {
    const f = await fixture(),
      e = await f.execution(),
      m = await f.message(1);
    await f.link(m.id);
    expect(
      (
        await db.query(
          "SELECT * FROM message_bot_attributions WHERE message_id=$1",
          [m.id],
        )
      ).rowCount,
    ).toBe(0);
    await f.delivery(e, m.guid);
    await f.link(m.id);
    expect(
      (
        await db.query<{ author: { workflowId: string; nickname: null } }>(
          "SELECT bot_message_author($1) author",
          [m.id],
        )
      ).rows[0]?.author,
    ).toMatchObject({ workflowId: f.workflow, nickname: null });
    await service.update(f.workflow, {
      nickname: "虚构甲",
      expectedVersion: 0,
    });
    const job = (
      await db.query<{ id: string }>(
        "SELECT id FROM bot_attribution_jobs WHERE workflow_id=$1 ORDER BY created_at DESC LIMIT 1",
        [f.workflow],
      )
    ).rows[0]!;
    for (let i = 0; i < 100; i++) {
      await service.work(job.id);
      if (
        (
          await db.query<{ status: string }>(
            "SELECT status FROM bot_attribution_jobs WHERE id=$1",
            [job.id],
          )
        ).rows[0]?.status === "succeeded"
      )
        break;
    }
    expect(
      (
        await db.query<{ nickname: string; basis: string }>(
          "SELECT nickname,basis FROM message_bot_attributions WHERE message_id=$1",
          [m.id],
        )
      ).rows[0],
    ).toEqual({ nickname: "虚构甲", basis: "historical-mapping" });
    const e2 = await f.execution();
    await service.update(f.workflow, {
      nickname: "虚构新名",
      expectedVersion: 1,
    });
    const guid = randomUUID();
    await f.delivery(e2, guid);
    const m2 = await f.message(2, guid);
    await f.link(m2.id);
    expect(
      (
        await db.query<{ nickname: string }>(
          "SELECT nickname FROM message_bot_attributions WHERE message_id=$1",
          [m2.id],
        )
      ).rows[0]?.nickname,
    ).toBe("虚构甲");
    await expect(
      service.update(f.workflow, { nickname: "冲突", expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "BOT_IDENTITY_CONFLICT" });
    const scope = { chatId: f.chat, upperIndex: 3 } as MemoryScope;
    const rows = await new ChatQueryRepository(db).query(
      scope,
      chatMessageQuerySchema.parse({ botWorkflowId: f.workflow }),
      "UTC",
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.message.author).toMatchObject({
      workflowId: f.workflow,
    });
    expect(
      (
        await new ChatQueryRepository(db).query(
          scope,
          chatMessageQuerySchema.parse({ botWorkflowId: randomUUID() }),
          "UTC",
        )
      ).rows,
    ).toHaveLength(0);
  });
  it("does not guess missing IDs or ambiguous deliveries and can associate redacted metadata", async () => {
    const f = await fixture(),
      e = await f.execution(),
      m = await f.message(1);
    await f.delivery(e, null);
    await f.link(m.id);
    expect(
      (
        await db.query(
          "SELECT 1 FROM message_bot_attributions WHERE message_id=$1",
          [m.id],
        )
      ).rowCount,
    ).toBe(0);
    await f.delivery(e, m.guid);
    await f.delivery(e, m.guid);
    await f.link(m.id);
    expect(
      (
        await db.query(
          "SELECT 1 FROM message_bot_attributions WHERE message_id=$1",
          [m.id],
        )
      ).rowCount,
    ).toBe(0);
    const m2 = await f.message(2);
    await db.query(
      "UPDATE messages SET body=NULL,content_redacted_at=now() WHERE id=$1",
      [m2.id],
    );
    await f.delivery(e, m2.guid);
    await f.link(m2.id);
    expect(
      (
        await db.query(
          "SELECT 1 FROM message_bot_attributions WHERE message_id=$1",
          [m2.id],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await new ChatQueryRepository(db).query(
          { chatId: f.chat, upperIndex: 3 } as MemoryScope,
          chatMessageQuerySchema.parse({ botWorkflowId: f.workflow }),
          "UTC",
        )
      ).rows,
    ).toHaveLength(0);
  });
  it("invalidates already summarized identities and starts a version-bound manual rebuild", async () => {
    const f = await fixture(),
      e = await f.execution(),
      m = await f.message(1),
      sid = randomUUID();
    await db.query(
      `INSERT INTO conversation_context_states(id,chat_id,summary_policy_version,summary,covered_through_index) VALUES($1,$2,1,'Fictional old combined Bot',1)`,
      [sid, f.chat],
    );
    await f.delivery(e, m.guid);
    await f.link(m.id);
    expect(
      (
        await db.query<{
          bot_summary_rebuild_required: boolean;
          bot_identity_revision: number;
        }>(
          "SELECT bot_summary_rebuild_required,bot_identity_revision FROM chats WHERE id=$1",
          [f.chat],
        )
      ).rows[0],
    ).toEqual({ bot_summary_rebuild_required: true, bot_identity_revision: 2 });
    // Isolate this fixture's pending-job check from unrelated integration fixtures.
    await db.query(
      "UPDATE bot_attribution_jobs SET status='succeeded' WHERE status='queued' AND message_id IS NOT NULL AND message_id IN(SELECT id FROM messages WHERE chat_id=$1)",
      [f.chat],
    );
    const settings = {
      enabled: true,
      providerRouteId: randomUUID(),
      policyVersion: 1,
      includeFromMe: true,
      timeZone: "UTC",
    };
    await service.rebuild(f.chat, settings);
    // Keep the global summary worker in other test files from claiming this fixture.
    await db.query(
      "INSERT INTO bot_attribution_jobs(message_id,through_index) VALUES($1,1)",
      [m.id],
    );
    await service.advanceSummaryRebuild(settings);
    const state = (
      await db.query<{ summary: string; bot_identity_revision: number }>(
        "SELECT summary,bot_identity_revision FROM conversation_context_states WHERE id=$1",
        [sid],
      )
    ).rows[0];
    expect(state).toEqual({ summary: "", bot_identity_revision: 2 });
    expect(
      (
        await db.query<{ bot_identity_revision: number }>(
          "SELECT bot_identity_revision FROM conversation_context_compressions WHERE context_state_id=$1",
          [sid],
        )
      ).rows[0]?.bot_identity_revision,
    ).toBe(2);
  });
  it("revokes a previously unique author when a late duplicate delivery creates ambiguity", async () => {
    const f = await fixture(),
      e = await f.execution(),
      m = await f.message(1);
    await f.delivery(e, m.guid);
    await f.link(m.id);
    expect(
      (
        await db.query<{ author: { kind: string; reason?: string } }>(
          "SELECT bot_message_author($1) author",
          [m.id],
        )
      ).rows[0]?.author.kind,
    ).toBe("bot");
    await f.delivery(await f.execution(), m.guid);
    await f.link(m.id);
    expect(
      (
        await db.query<{ author: { kind: string; reason?: string } }>(
          "SELECT bot_message_author($1) author",
          [m.id],
        )
      ).rows[0]?.author,
    ).toMatchObject({ kind: "unknown-self", reason: "ambiguous" });
    expect(
      (
        await db.query(
          "SELECT bot_summary_rebuild_required, bot_memory_rebuild_required FROM chats WHERE id=$1",
          [f.chat],
        )
      ).rows[0],
    ).toEqual({
      bot_summary_rebuild_required: true,
      bot_memory_rebuild_required: true,
    });
    expect(
      (
        await new ChatQueryRepository(db).query(
          { chatId: f.chat, upperIndex: 2 } as MemoryScope,
          chatMessageQuerySchema.parse({ botWorkflowId: f.workflow }),
          "UTC",
        )
      ).rows,
    ).toHaveLength(0);
  });
  it("groups Bot identities separately on a shared gateway sender", async () => {
    const a = await fixture(),
      b = await fixture();
    const ma = await a.message(1),
      mb = await b.message(2),
      ea = await a.execution(),
      eb = await b.execution();
    await a.delivery(ea, ma.guid);
    const delivery = await b.delivery(eb, mb.guid);
    await db.query("UPDATE messages SET chat_id=$1 WHERE id=$2", [
      a.chat,
      mb.id,
    ]);
    await db.query(
      "UPDATE outbound_deliveries SET provider_chat_id=$1 WHERE id=$2",
      [a.chat, delivery],
    );
    await a.link(ma.id);
    await b.link(mb.id);
    const page = await new ChatQueryRepository(db).aggregate(
      { chatId: a.chat, upperIndex: 3 } as MemoryScope,
      chatCountQuerySchema.parse({ groupBy: "sender" }),
      "UTC",
    );
    expect(page.rows).toHaveLength(2);
    expect(page.rows.map((r) => r.count)).toEqual([1, 1]);
    expect(
      new Set(
        page.rows.map((r) =>
          r.author?.kind === "bot" ? r.author.workflowId : null,
        ),
      ),
    ).toEqual(new Set([a.workflow, b.workflow]));
  });
});
