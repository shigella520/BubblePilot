import type { BotIdentity } from "./bot-identity.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { createPostgresPool } from "../shared/postgres-pool.js";
import { ApplicationError } from "../../app/errors.js";
export const botIdentityUpdateSchema = z
  .object({
    nickname: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[^\p{Cc}\p{Cf}]+$/u),
    expectedVersion: z.number().int().min(0),
  })
  .strict();
export class BotIdentityService {
  readonly pool: Pool;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  constructor(databaseUrl: string, queryTimeoutMs?: number) {
    this.pool = createPostgresPool(databaseUrl, 3, queryTimeoutMs);
  }
  async view(workflowId: string) {
    const row = (
      await this.pool.query<{
        workflowId: string;
        nickname: string | null;
        version: number;
        updatedAt: Date | null;
        firstNickname: string | null;
      }>(
        `SELECT w.id AS "workflowId",i.nickname,coalesce(i.version,0) AS version,i.updated_at AS "updatedAt",i.first_nickname AS "firstNickname" FROM workflows w LEFT JOIN workflow_bot_identities i ON i.workflow_id=w.id WHERE w.id=$1 AND w.deleted_at IS NULL`,
        [workflowId],
      )
    ).rows[0];
    if (!row)
      throw new ApplicationError(
        "WORKFLOW_NOT_FOUND",
        "Workflow unavailable.",
        404,
      );
    return row;
  }
  async update(
    workflowId: string,
    input: z.infer<typeof botIdentityUpdateSchema>,
  ) {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const workflow = await db.query(
        "SELECT id FROM workflows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [workflowId],
      );
      if (!workflow.rowCount)
        throw new ApplicationError(
          "WORKFLOW_NOT_FOUND",
          "Workflow unavailable.",
          404,
        );
      const old = (
        await db.query<{ version: number }>(
          "SELECT version FROM workflow_bot_identities WHERE workflow_id=$1",
          [workflowId],
        )
      ).rows[0];
      if ((old?.version ?? 0) !== input.expectedVersion)
        throw new ApplicationError(
          "BOT_IDENTITY_CONFLICT",
          "Role changed; refresh before saving.",
          409,
        );
      await db.query(
        `INSERT INTO workflow_bot_identities(workflow_id,nickname,first_nickname) VALUES($1,$2,$2) ON CONFLICT(workflow_id) DO UPDATE SET nickname=$2,version=workflow_bot_identities.version+1,updated_at=now()`,
        [workflowId, input.nickname],
      );
      if (!old) await this.queue(db, workflowId);
      await db.query("COMMIT");
      return this.view(workflowId);
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  private async queue(db: Pool | PoolClient, workflowId: string | null) {
    const row = (
      await db.query<{ id: string }>(
        `INSERT INTO bot_attribution_jobs(workflow_id,through_index) SELECT $1,coalesce(max(message_index),0) FROM messages RETURNING id`,
        [workflowId],
      )
    ).rows[0];
    return row;
  }
  async startBackfill(workflowId?: string) {
    if (workflowId) await this.view(workflowId);
    return this.queue(this.pool, workflowId ?? null);
  }
  async preview() {
    return (
      await this.pool.query<{
        total: number;
        matchable: number;
        unknown: number;
        conflicts: number;
        linked: number;
      }>(
        `WITH candidates AS (SELECT m.id,count(d.id) n FROM messages m JOIN chats c ON c.id=m.chat_id LEFT JOIN outbound_deliveries d ON d.provider=m.provider AND d.provider_chat_id=c.provider_chat_id AND d.provider_message_id=m.provider_message_id WHERE m.is_from_me GROUP BY m.id) SELECT count(*)::int total,count(*) FILTER(WHERE n=1)::int matchable,count(*) FILTER(WHERE n=0)::int unknown,count(*) FILTER(WHERE n>1)::int conflicts,(SELECT count(*)::int FROM message_bot_attributions) linked FROM candidates`,
      )
    ).rows[0];
  }
  async workflowCoverage() {
    return (
      await this.pool.query<{
        workflowId: string;
        name: string;
        nickname: string | null;
        total: number;
        bound: number;
        unbound: number;
        nicknamePending: number;
      }>(`WITH candidates AS (
      SELECT m.id, min(d.id::text)::uuid delivery_id FROM messages m JOIN chats c ON c.id=m.chat_id
      JOIN outbound_deliveries d ON d.provider=m.provider AND d.provider_chat_id=c.provider_chat_id AND d.provider_message_id=m.provider_message_id
      WHERE m.is_from_me GROUP BY m.id HAVING count(d.id)=1
    ), counts AS (
      SELECT v.workflow_id, count(*)::int total,
        count(*) FILTER(WHERE a.delivery_id=d.id AND a.workflow_id=v.workflow_id)::int bound,
        count(*) FILTER(WHERE a.delivery_id=d.id AND a.workflow_id=v.workflow_id AND a.nickname IS NULL AND i.nickname IS NOT NULL)::int nickname_pending
      FROM candidates c JOIN outbound_deliveries d ON d.id=c.delivery_id
      JOIN workflow_executions e ON e.id=d.execution_id JOIN workflow_versions v ON v.id=e.workflow_version_id
      LEFT JOIN message_bot_attributions a ON a.message_id=c.id
      LEFT JOIN workflow_bot_identities i ON i.workflow_id=v.workflow_id GROUP BY v.workflow_id
    ) SELECT w.id AS "workflowId",w.name,i.nickname,coalesce(c.total,0)::int total,coalesce(c.bound,0)::int bound,
      (coalesce(c.total,0)-coalesce(c.bound,0))::int unbound,coalesce(c.nickname_pending,0)::int AS "nicknamePending"
      FROM workflows w LEFT JOIN counts c ON c.workflow_id=w.id LEFT JOIN workflow_bot_identities i ON i.workflow_id=w.id
      WHERE w.deleted_at IS NULL OR c.total>0 ORDER BY w.name,w.id`)
    ).rows;
  }
  async status(workflowId?: string) {
    if (workflowId) await this.view(workflowId);
    const relatedChats = workflowId
      ? (
          await this.pool.query<{ id: string }>(
            `SELECT DISTINCT c.id FROM chats c JOIN outbound_deliveries d ON d.provider=c.provider AND d.provider_chat_id=c.provider_chat_id JOIN workflow_executions e ON e.id=d.execution_id JOIN workflow_versions v ON v.id=e.workflow_version_id WHERE v.workflow_id=$1 AND c.deleted_at IS NULL`,
            [workflowId],
          )
        ).rows.map((c) => c.id)
      : null;
    const result = {
      preview: await this.preview(),
      workflows: await this.workflowCoverage(),
      jobs: (
        await this.pool.query<Record<string, unknown>>(
          `SELECT id,workflow_id,status,processed,linked,unknown_count,conflict_count,error_code,created_at,updated_at FROM bot_attribution_jobs WHERE ($1::uuid IS NULL OR workflow_id=$1) ORDER BY created_at DESC LIMIT 50`,
          [workflowId ?? null],
        )
      ).rows,
      memoryJobs: (
        await this.pool.query<Record<string, unknown>>(
          `SELECT j.id,j.chat_id,c.display_name,j.status,j.cursor_index,j.through_index,j.error_code FROM memory_jobs j JOIN chats c ON c.id=j.chat_id WHERE j.reason='rebuild' AND ($1::uuid[] IS NULL OR j.chat_id=ANY($1)) ORDER BY j.created_at DESC LIMIT 30`,
          [relatedChats],
        )
      ).rows,
      chats: (
        await this.pool.query<Record<string, unknown>>(
          `SELECT id,display_name,bot_identity_revision,bot_memory_rebuild_required FROM chats WHERE deleted_at IS NULL AND (($1::uuid[] IS NOT NULL AND id=ANY($1)) OR ($1::uuid[] IS NULL AND (bot_memory_rebuild_required)))`,
          [relatedChats],
        )
      ).rows,
    };
    if (!relatedChats) return result;
    return {
      ...result,
      preview: undefined,
      workflows: result.workflows.filter((w) => w.workflowId === workflowId),
      memoryJobs: result.memoryJobs.filter((j) =>
        relatedChats.includes(String(j.chat_id)),
      ),
    };
  }
  async retry(id: string) {
    return (
      (
        await this.pool.query<{ id: string }>(
          `UPDATE bot_attribution_jobs SET status='queued',error_code=NULL WHERE id=$1 AND status='failed' RETURNING id`,
          [id],
        )
      ).rows[0] ?? null
    );
  }
  start(afterWork?: () => Promise<void>) {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = this.work()
        .then(() => afterWork?.())
        .catch(() => undefined)
        .finally(() => {
          this.running = null;
        });
    };
    this.timer = setInterval(tick, 1000);
    this.timer.unref();
    tick();
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
    await this.pool.end();
  }
  async rebuild(chatId: string, _target: "memory" = "memory") {
    void _target;
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const c = (
        await db.query<{
          bot_identity_revision: number;
        }>(
          "SELECT * FROM chats WHERE id=$1 AND enabled AND deleted_at IS NULL FOR UPDATE",
          [chatId],
        )
      ).rows[0];
      if (!c)
        throw new ApplicationError("CHAT_NOT_FOUND", "Chat unavailable.", 404);
      if (
        (
          await db.query(
            `SELECT 1 FROM bot_attribution_jobs j WHERE j.status IN ('queued','running') AND ((j.message_id IS NOT NULL AND EXISTS(SELECT 1 FROM messages m WHERE m.id=j.message_id AND m.chat_id=$1)) OR (j.message_id IS NULL AND (j.workflow_id IS NULL OR EXISTS(SELECT 1 FROM outbound_deliveries d JOIN workflow_executions e ON e.id=d.execution_id JOIN workflow_versions v ON v.id=e.workflow_version_id JOIN chats c ON c.provider=d.provider AND c.provider_chat_id=d.provider_chat_id WHERE v.workflow_id=j.workflow_id AND c.id=$1)))) LIMIT 1`,
            [chatId],
          )
        ).rowCount
      )
        throw new ApplicationError(
          "BOT_ATTRIBUTION_BUSY",
          "Finish attribution before rebuilding.",
          409,
        );
      const result = { memory: false };
      const memory = (
        await db.query<{ id: string }>(
          `SELECT g.id FROM memory_generations g WHERE g.status='active' AND EXISTS(SELECT 1 FROM memory_settings WHERE enabled) AND EXISTS(SELECT 1 FROM memory_chats WHERE chat_id=$1 AND enabled)`,
          [chatId],
        )
      ).rows[0];
      if (memory) {
        await db.query(
          "UPDATE memory_jobs SET status='superseded',lease_owner=NULL WHERE chat_id=$1 AND status IN ('queued','running','paused')",
          [chatId],
        );
        await db.query(
          "UPDATE memory_chunks SET valid=FALSE WHERE chat_id=$1",
          [chatId],
        );
        await db.query(
          "DELETE FROM memory_indexed_messages i USING messages m WHERE i.message_id=m.id AND m.chat_id=$1",
          [chatId],
        );
        await db.query(
          "UPDATE chats SET bot_memory_rebuild_required=FALSE WHERE id=$1",
          [chatId],
        );
        await db.query(
          `INSERT INTO memory_jobs(chat_id,generation_id,reason,from_index,through_index,cursor_index) SELECT c.id,$2,'rebuild',1,c.next_message_index-1,0 FROM chats c WHERE c.id=$1 AND c.next_message_index>1`,
          [chatId, memory.id],
        );
        result.memory = true;
      }
      await db.query("COMMIT");
      return result;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }

  async work(jobId?: string) {
    const owner = randomUUID();
    const job = (
      await this.pool.query<{
        id: string;
        through_index: string;
        message_id: string | null;
        cursor_message: string | null;
        workflow_id: string | null;
      }>(
        `UPDATE bot_attribution_jobs SET status='running',lease_owner=$1,lease_until=now()+interval '60 seconds' WHERE id=(SELECT id FROM bot_attribution_jobs WHERE ($2::uuid IS NULL OR id=$2) AND (status='queued' OR (status='running' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
        [owner, jobId ?? null],
      )
    ).rows[0];
    if (!job) return;
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const owned = await db.query(
        "SELECT id FROM bot_attribution_jobs WHERE id=$1 AND lease_owner=$2 FOR UPDATE",
        [job.id, owner],
      );
      if (!owned.rowCount) {
        await db.query("ROLLBACK");
        return;
      }
      const rows = (
        await db.query<{ id: string; chat_id: string; message_index: string }>(
          `SELECT m.id,m.chat_id,m.message_index FROM messages m WHERE m.is_from_me AND m.message_index<=$1 AND ($2::uuid IS NULL OR m.id=$2) AND ($3::uuid IS NULL OR m.id>$3) AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM chats c JOIN outbound_deliveries d ON d.provider=c.provider AND d.provider_chat_id=c.provider_chat_id JOIN workflow_executions e ON e.id=d.execution_id JOIN workflow_versions v ON v.id=e.workflow_version_id WHERE c.id=m.chat_id AND d.provider_message_id=m.provider_message_id AND v.workflow_id=$4)) ORDER BY m.id LIMIT 200`,
          [
            job.through_index,
            job.message_id,
            job.cursor_message,
            job.workflow_id,
          ],
        )
      ).rows;
      if (rows.length)
        await db.query(
          "SELECT id FROM chats WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
          [[...new Set(rows.map((m) => m.chat_id))]],
        );
      let linked = 0,
        unknown = 0,
        conflicts = 0;
      const affected = new Set<string>();
      for (const m of rows) {
        const matches = (
          await db.query<{
            id: string;
            execution_id: string;
            workflow_version_id: string;
            workflow_id: string;
            node_id: string;
            bot_identity: BotIdentity | null;
            first_nickname: string | null;
          }>(
            `SELECT d.id,d.execution_id,e.workflow_version_id,v.workflow_id,d.node_id,d.bot_identity,i.first_nickname FROM messages m JOIN chats c ON c.id=m.chat_id JOIN outbound_deliveries d ON d.provider=m.provider AND d.provider_chat_id=c.provider_chat_id AND d.provider_message_id=m.provider_message_id JOIN workflow_executions e ON e.id=d.execution_id JOIN workflow_versions v ON v.id=e.workflow_version_id LEFT JOIN workflow_bot_identities i ON i.workflow_id=v.workflow_id WHERE m.id=$1`,
            [m.id],
          )
        ).rows;
        if (matches.length !== 1) {
          await db.query(
            "UPDATE messages SET bot_attribution_issue=$2 WHERE id=$1 AND bot_attribution_issue IS DISTINCT FROM $2",
            [m.id, matches.length ? "ambiguous" : "unmatched"],
          );
          if (matches.length) conflicts++;
          else unknown++;
          const removed = await db.query(
            "DELETE FROM message_bot_attributions WHERE message_id=$1 RETURNING message_id",
            [m.id],
          );
          if (removed.rowCount) affected.add(m.chat_id);
          continue;
        }
        const d = matches[0]!;
        if (job.workflow_id && d.workflow_id !== job.workflow_id) continue;
        await db.query(
          "UPDATE messages SET bot_attribution_issue=NULL WHERE id=$1 AND bot_attribution_issue IS NOT NULL",
          [m.id],
        );
        const nickname = d.bot_identity?.nickname ?? d.first_nickname ?? null;
        const changed = await db.query(
          `INSERT INTO message_bot_attributions(message_id,delivery_id,execution_id,workflow_id,workflow_version_id,node_id,nickname,identity_version,basis) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(message_id) DO UPDATE SET nickname=EXCLUDED.nickname,identity_version=EXCLUDED.identity_version,basis=EXCLUDED.basis,revision=message_bot_attributions.revision+1 WHERE message_bot_attributions.delivery_id=EXCLUDED.delivery_id AND message_bot_attributions.nickname IS NULL AND EXCLUDED.nickname IS NOT NULL RETURNING message_id`,
          [
            m.id,
            d.id,
            d.execution_id,
            d.workflow_id,
            d.workflow_version_id,
            d.node_id,
            nickname,
            d.bot_identity?.nickname
              ? d.bot_identity.version
              : nickname
                ? 1
                : 0,
            d.bot_identity?.nickname ? "send-snapshot" : "historical-mapping",
          ],
        );
        if (changed.rowCount) {
          linked++;
          const derived = await db.query(
            `SELECT 1 FROM memory_chunks WHERE chat_id=$1 AND through_index>=$2 AND from_index<=$2 AND valid UNION ALL SELECT 1 FROM memory_jobs WHERE chat_id=$1 AND status='running' AND through_index>=$2 LIMIT 1`,
            [m.chat_id, m.message_index],
          );
          if (derived.rowCount) affected.add(m.chat_id);
        }
      }
      for (const chatId of affected)
        await db.query(
          `UPDATE chats SET bot_identity_revision=bot_identity_revision+1,bot_memory_rebuild_required=TRUE WHERE id=$1`,
          [chatId],
        );
      await db.query(
        `UPDATE bot_attribution_jobs SET status=$3,cursor_message=coalesce($4,cursor_message),processed=processed+$5,linked=linked+$6,unknown_count=unknown_count+$7,conflict_count=conflict_count+$8,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_owner=$2`,
        [
          job.id,
          owner,
          rows.length < 200 ? "succeeded" : "queued",
          rows.at(-1)?.id ?? null,
          rows.length,
          linked,
          unknown,
          conflicts,
        ],
      );
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      await this.pool.query<{
        id: string;
        through_index: string;
        message_id: string | null;
        cursor_message: string | null;
        workflow_id: string | null;
      }>(
        `UPDATE bot_attribution_jobs SET status='failed',error_code='ATTRIBUTION_FAILED',updated_at=now() WHERE id=$1 AND lease_owner=$2`,
        [job.id, owner],
      );
      throw e;
    } finally {
      db.release();
    }
  }
}
