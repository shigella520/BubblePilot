import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { MessageDetailClient } from "../integrations/bluebubbles/message-detail.js";
import type { MessageEnvelope } from "../ingestion/message-envelope.js";
import type { IngestionResult } from "./archive-repository.js";
import {
  revisionLimits,
  type MessageRevision,
  type ReplyPreview,
  type RevisionNotification,
} from "./message-revision.js";

interface Job {
  id: string;
  event_key: string;
  provider_message_id: string;
  kind: "reply" | "revision";
  source_time: Date | null;
  attempts: number;
  lease_id: string;
}
export interface RevisionIngestion {
  enqueue(notification: RevisionNotification): Promise<IngestionResult>;
  attachReply(
    envelope: MessageEnvelope,
    afterMessageIndex: string | null,
  ): Promise<ReplyPreview | null>;
}

export class MessageRevisionService implements RevisionIngestion {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  constructor(
    private readonly pool: Pool,
    private readonly details: MessageDetailClient,
  ) {}

  async enqueue(n: RevisionNotification): Promise<IngestionResult> {
    const created = await this.queue(
      n.eventId,
      n.providerMessageId,
      "revision",
      n.correlationId,
      n.sourceTime,
      n.payloadHash,
    );
    return {
      status: created ? "ignored" : "duplicate",
      messageId: null,
      eventId: n.eventId,
      correlationId: n.correlationId,
      automationOutcome: "not-evaluated",
    };
  }

  private async queue(
    key: string,
    guid: string,
    kind: "revision" | "reply",
    correlation: string,
    time: string | null,
    hash: string,
  ) {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtext('message-revision-queue'))",
      );
      const existing = await db.query(
        "SELECT id FROM message_revision_jobs WHERE event_key=$1",
        [key],
      );
      if (existing.rowCount) {
        await db.query("COMMIT");
        return false;
      }
      const count = await db.query<{ n: string }>(
        "SELECT count(*) n FROM message_revision_jobs WHERE status IN ('pending','running')",
      );
      if (Number(count.rows[0]?.n) >= revisionLimits.pendingCount)
        throw new Error("MESSAGE_REVISION_QUEUE_FULL");
      await db.query(
        `INSERT INTO message_revision_jobs(id,event_key,provider_message_id,kind,correlation_id,source_time,payload_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), key, guid, kind, correlation, time, hash],
      );
      if (kind === "revision")
        await db.query(
          `INSERT INTO inbound_events(id,provider,external_event_id,correlation_id,event_type,payload_hash,status,automation_outcome)
        VALUES($1,'bluebubbles',$2,$3,'updated-message',$4,'completed','not-evaluated') ON CONFLICT DO NOTHING`,
          [randomUUID(), key, correlation, hash],
        );
      await db.query("COMMIT");
      return true;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }

  async attachReply(
    envelope: MessageEnvelope,
    afterMessageIndex: string | null,
  ): Promise<ReplyPreview | null> {
    if (!envelope.message.replyReference) return null;
    await this.queue(
      `reply:${envelope.message.providerMessageId}`,
      envelope.message.providerMessageId,
      "reply",
      envelope.correlationId,
      null,
      envelope.metadata.payloadHash,
    );
    // Hydrate only the just-archived source, never fetch an unarchived quote
    // target. This bounded read improves the current trigger's quote snapshot.
    if (envelope.message.replyReference.part === null) {
      try {
        const detail = await this.details.read(
          envelope.message.providerMessageId,
        );
        if (
          !detail.sourceTime &&
          detail.text === envelope.message.text &&
          detail.chatGuids.includes(envelope.chat.providerChatId) &&
          detail.reply?.targetGuid ===
            envelope.message.replyReference.targetGuid
        ) {
          await this.pool.query(
            `UPDATE messages m SET reply_part=$2 FROM chats c
            WHERE m.chat_id=c.id AND m.provider='bluebubbles' AND m.provider_message_id=$1
            AND c.enabled AND c.deleted_at IS NULL AND m.content_redacted_at IS NULL
            AND m.revision_number=0 AND m.reply_target_guid=$3`,
            [
              envelope.message.providerMessageId,
              detail.reply.part,
              detail.reply.targetGuid,
            ],
          );
        }
      } catch {
        /* The durable job retries; normal message dispatch continues. */
      }
    }
    if (afterMessageIndex === null) return { status: "unresolved" };
    const result = await this.pool.query<{ reply: ReplyPreview | null }>(
      `SELECT message_reply_preview(m.id,$2,m.message_index) reply
      FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.provider='bluebubbles' AND m.provider_message_id=$1
      AND c.enabled AND c.deleted_at IS NULL`,
      [envelope.message.providerMessageId, afterMessageIndex],
    );
    return result.rows[0]?.reply ?? { status: "unavailable" };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, revisionLimits.intervalMs);
    this.timer.unref();
    void this.tick().catch(() => undefined);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
    await this.pool.end();
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runBatch().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async runBatch() {
    await this.pool
      .query(`UPDATE message_revision_jobs SET status='failed',reason='expired',completed_at=now(),lease_id=NULL,lease_until=NULL
      WHERE status IN ('pending','running') AND created_at < now()-interval '24 hours'`);
    await this.pool.query(
      `UPDATE message_revision_jobs SET status='failed',reason='attempts-exhausted',completed_at=now(),lease_id=NULL,lease_until=NULL
      WHERE attempts >= $1 AND (status='pending' OR (status='running' AND lease_until<now()))`,
      [revisionLimits.attempts],
    );
    for (let i = 0; i < 5; i++) {
      const job = (
        await this.pool.query<Job>(
          `WITH candidate AS (
        SELECT id FROM message_revision_jobs WHERE (status='pending' OR (status='running' AND lease_until<now()))
        AND next_attempt_at<=now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE message_revision_jobs j SET status='running',lease_id=$1,lease_until=now()+interval '30 seconds',attempts=attempts+1
        FROM candidate c WHERE j.id=c.id RETURNING j.*`,
          [randomUUID()],
        )
      ).rows[0];
      if (!job) break;
      try {
        const target = (
          await this.pool.query<{
            enabled: boolean;
            content_redacted_at: Date | null;
            deleted_at: Date | null;
          }>(
            `SELECT c.enabled,c.deleted_at,m.content_redacted_at FROM messages m JOIN chats c ON c.id=m.chat_id
           WHERE m.provider='bluebubbles' AND m.provider_message_id=$1`,
            [job.provider_message_id],
          )
        ).rows[0];
        if (!target) {
          await this.retry(job, "target-not-archived");
          continue;
        }
        if (
          target.deleted_at ||
          target.content_redacted_at ||
          (!target.enabled && job.kind === "reply")
        ) {
          await this.finish(job, "ignored", "archive-unavailable");
          continue;
        }
        const detail = await this.details.read(job.provider_message_id);
        if (
          job.source_time &&
          (!detail.sourceTime ||
            Date.parse(detail.sourceTime) < job.source_time.getTime())
        ) {
          await this.retry(job, "detail-not-current");
          continue;
        }
        await this.apply(job, detail);
      } catch {
        await this.retry(job, "detail-or-apply-failed");
      }
    }
  }
  private async finish(
    job: Job,
    status: string,
    reason: string,
    db: Pool | PoolClient = this.pool,
  ) {
    await db.query(
      `UPDATE message_revision_jobs SET status=$3,reason=$4,completed_at=now(),lease_id=NULL,lease_until=NULL
      WHERE id=$1 AND lease_id=$2`,
      [job.id, job.lease_id, status, reason],
    );
  }
  private async retry(job: Job, reason: string) {
    if (job.attempts >= revisionLimits.attempts)
      return this.finish(job, "failed", reason);
    await this.pool.query(
      `UPDATE message_revision_jobs SET status='pending',reason=$3,lease_id=NULL,lease_until=NULL,
      next_attempt_at=now()+($4::int*interval '1 second') WHERE id=$1 AND lease_id=$2`,
      [job.id, job.lease_id, reason, job.attempts * 15],
    );
  }
  private async apply(job: Job, detail: MessageRevision) {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const lease = await db.query(
        "SELECT id FROM message_revision_jobs WHERE id=$1 AND lease_id=$2 AND status='running' AND lease_until>now() FOR UPDATE",
        [job.id, job.lease_id],
      );
      if (!lease.rowCount) {
        await db.query("ROLLBACK");
        return;
      }
      // Match the existing memory/archive lock order: chat, then message.
      await db.query(
        `SELECT c.id FROM chats c JOIN messages m ON m.chat_id=c.id
        WHERE m.provider='bluebubbles' AND m.provider_message_id=$1 FOR SHARE OF c`,
        [job.provider_message_id],
      );
      const target = (
        await db.query<{
          id: string;
          provider_chat_id: string;
          revision_source_at: Date | null;
          revision_state: string;
          enabled: boolean;
          revision_hash: string | null;
        }>(
          `SELECT m.id,c.provider_chat_id,m.revision_source_at,m.revision_state,m.revision_hash,c.enabled
        FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.provider='bluebubbles' AND m.provider_message_id=$1
        AND c.deleted_at IS NULL AND m.content_redacted_at IS NULL FOR UPDATE OF m`,
          [job.provider_message_id],
        )
      ).rows[0];
      if (
        !target ||
        !detail.chatGuids.includes(target.provider_chat_id) ||
        (!target.enabled && !["retracted", "partial"].includes(detail.state))
      ) {
        await this.finish(job, "ignored", "target-unavailable", db);
      } else {
        const oldTime = target.revision_source_at?.getTime() ?? 0;
        const newTime = detail.sourceTime ? Date.parse(detail.sourceTime) : 0;
        if (
          target.revision_hash === detail.hash ||
          newTime < oldTime ||
          target.revision_state === "retracted"
        ) {
          await this.finish(job, "ignored", "duplicate-or-stale", db);
        } else if (oldTime && newTime === oldTime && target.revision_hash) {
          await this.finish(job, "failed", "same-time-conflict", db);
        } else {
          // Once part retraction is observed, later edits cannot restore its text.
          const hidden =
            detail.state !== "active" ||
            ["partial"].includes(target.revision_state);
          const state =
            target.revision_state === "partial" && detail.state !== "retracted"
              ? "partial"
              : detail.state;
          if (detail.sourceTime) {
            await db.query(
              `UPDATE messages SET body=$2,attachments=$3::jsonb,content_hash=$4,
              content_type=CASE WHEN $2::text IS NOT NULL THEN CASE WHEN jsonb_array_length($3::jsonb)>0 THEN 'mixed' ELSE 'text' END ELSE CASE WHEN jsonb_array_length($3::jsonb)>0 THEN 'attachment' ELSE 'unknown' END END,
              revision_state=$5,revision_number=revision_number+1,revision_source_at=$6,edited_at=CASE WHEN $5='active' THEN $6::timestamptz ELSE edited_at END,revision_hash=$4,
              reply_target_guid=COALESCE($7,reply_target_guid),reply_part=COALESCE($8,reply_part),
              link_previews='[]',link_preview_status='not-requested',link_preview_diagnostics='[]',link_preview_error_code=NULL,
              link_preview_fetched_at=NULL
              WHERE id=$1`,
              [
                target.id,
                hidden ? null : detail.text,
                JSON.stringify(hidden ? [] : detail.attachments),
                detail.hash,
                state,
                detail.sourceTime,
                detail.reply?.targetGuid ?? null,
                detail.reply?.part ?? null,
              ],
            );
            await db.query(
              `UPDATE message_image_summaries SET status='unavailable',summary=NULL,image_content_hash=NULL,
              lease_owner=NULL,lease_expires_at=NULL,error_code='MESSAGE_REVISED',updated_at=now() WHERE message_id=$1`,
              [target.id],
            );
          } else if (job.kind === "reply") {
            await db.query(
              "UPDATE messages SET reply_target_guid=$2,reply_part=$3 WHERE id=$1",
              [
                target.id,
                detail.reply?.targetGuid ?? null,
                detail.reply?.part ?? null,
              ],
            );
          }
          await this.finish(
            job,
            "applied",
            state === "retracted"
              ? "retracted"
              : hidden
                ? "parts-unresolved"
                : "current-state",
            db,
          );
        }
      }
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
}
