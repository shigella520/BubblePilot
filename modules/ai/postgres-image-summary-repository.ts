import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { sha256 } from "../../app/canonical-json.js";
import {
  linkPreviewItemSchema,
  type LinkPreviewItem,
} from "../ingestion/link-preview.js";
import type { MessageAttachment } from "../ingestion/message-envelope.js";
import { createPostgresPool } from "../shared/postgres-pool.js";
import type { ImageSummaryRepository } from "./image-summary-repository.js";
import type {
  ImageSummaryCompletion,
  ImageSummaryContentInput,
  ImageSummaryJob,
  ImageSummarySource,
  ImageSummaryStatus,
  MessageImageSummary,
} from "./image-summary-types.js";

interface SummaryRow {
  id: string;
  chat_id: string;
  content_lease_token: string | null;
  lease_expires_at: Date;
  result_origin: "model" | "cache" | null;
  reused_at: Date | null;
  provider_attempt_count: string;
  message_id: string;
  provider_message_id: string;
  source_type: "attachment" | "link-preview";
  source_key: string;
  attachment_ref: string;
  image_content_hash: string | null;
  summary: string | null;
  status: ImageSummaryStatus;
  provider_name: string | null;
  model: string | null;
  contract_version: string;
  attempt_count: number;
  error_code: string | null;
  duration_ms: number | null;
  generated_at: Date | null;
  attachments: unknown;
  link_previews: unknown;
}

function attachments(value: unknown): readonly MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.providerAttachmentId !== "string") return [];
    return [
      {
        providerAttachmentId: record.providerAttachmentId,
        mimeType: typeof record.mimeType === "string" ? record.mimeType : null,
        fileName: typeof record.fileName === "string" ? record.fileName : null,
        sizeBytes:
          typeof record.sizeBytes === "number" ? record.sizeBytes : null,
      },
    ];
  });
}

function linkPreviews(value: unknown): readonly LinkPreviewItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = linkPreviewItemSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function sourceFor(row: SummaryRow): ImageSummarySource | null {
  if (row.source_type === "attachment") {
    const attachment = attachments(row.attachments).find(
      (item) => item.providerAttachmentId === row.source_key,
    );
    return attachment === undefined
      ? null
      : {
          sourceType: "attachment",
          sourceKey: row.source_key,
          attachmentRef: row.attachment_ref,
          attachment,
        };
  }
  const preview = linkPreviews(row.link_previews).find(
    (item) => item.imageUrl === row.source_key,
  );
  return preview === undefined
    ? null
    : {
        sourceType: "link-preview",
        sourceKey: row.source_key,
        attachmentRef: row.attachment_ref,
        preview,
      };
}

function summaryView(row: SummaryRow): MessageImageSummary {
  return {
    operationId: row.id,
    resultOrigin:
      row.status === "succeeded" ? (row.result_origin ?? "legacy") : null,
    reusedAt: row.reused_at?.toISOString() ?? null,
    providerAttemptCount: Number(row.provider_attempt_count ?? 0),
    attachmentRef: row.attachment_ref,
    sourceType: row.source_type,
    sourceKeyHash: sha256(row.source_key),
    imageContentHash: row.image_content_hash,
    status: row.status,
    summary: row.summary,
    providerName: row.provider_name,
    model: row.model,
    contractVersion: row.contract_version,
    attemptCount: row.attempt_count,
    errorCode: row.error_code,
    durationMs: row.duration_ms,
    generatedAt: row.generated_at?.toISOString() ?? null,
  };
}

const summarySelect = `SELECT summary.id, summary.message_id,
  message.provider_message_id, summary.source_type, summary.source_key,
  summary.attachment_ref, summary.image_content_hash, summary.summary,
  summary.status, summary.provider_name, summary.model,
  summary.contract_version, summary.attempt_count, summary.error_code,
  summary.duration_ms, summary.generated_at, summary.result_origin, summary.reused_at,
  (SELECT count(*) FROM ai_provider_attempts a
   WHERE a.background_operation_id=summary.id AND a.purpose='image-summary') provider_attempt_count,
  message.attachments, message.link_previews
FROM message_image_summaries summary
INNER JOIN messages message ON message.id = summary.message_id`;

export class PostgresImageSummaryRepository implements ImageSummaryRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string, queryTimeoutMs?: number) {
    this.pool = createPostgresPool(databaseUrl, 4, queryTimeoutMs);
  }

  async enqueue(
    messageId: string,
    source: ImageSummarySource,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO message_image_summaries (
         id, message_id, source_type, source_key, attachment_ref, status
       ) SELECT $1, $2, $3, $4, $5, 'pending' FROM messages m
       WHERE m.id=$2 AND m.revision_number=0 AND m.content_redacted_at IS NULL
       ON CONFLICT (message_id, source_type, source_key) DO NOTHING`,
      [
        randomUUID(),
        messageId,
        source.sourceType,
        source.sourceKey,
        source.attachmentRef,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async claimNext(input: {
    leaseOwner: string;
    leaseMs: number;
    maxAttempts: number;
  }): Promise<ImageSummaryJob | null> {
    // Separate autocommit cleanup avoids locking leases before message rows.
    await this.pool.query(
      "DELETE FROM image_summary_content_leases WHERE expires_at <= clock_timestamp()",
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `WITH expired AS MATERIALIZED (
           SELECT s.id FROM message_image_summaries s JOIN messages m ON m.id=s.message_id
           WHERE s.status='processing' AND s.lease_expires_at<=clock_timestamp()
           ORDER BY m.id,s.id LIMIT 100 FOR UPDATE OF m SKIP LOCKED
         ) UPDATE message_image_summaries s
         SET status = CASE WHEN attempt_count >= $1 THEN 'failed' ELSE 'pending' END,
             error_code='IMAGE_SUMMARY_LEASE_EXPIRED',lease_owner=NULL,content_lease_token=NULL,
             lease_expires_at=NULL,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
         FROM expired WHERE s.id=expired.id AND s.status='processing'
           AND s.lease_expires_at<=clock_timestamp()`,
        [input.maxAttempts],
      );
      await client.query("COMMIT");
      await client.query("BEGIN");
      const result = await client.query<SummaryRow>(
        `WITH candidate AS (
           SELECT s.id FROM message_image_summaries s JOIN messages m ON m.id=s.message_id
           WHERE s.status = 'pending' AND s.next_attempt_at <= clock_timestamp()
             AND s.attempt_count < $3
           ORDER BY s.next_attempt_at, s.created_at, s.id
           LIMIT 1 FOR UPDATE OF m SKIP LOCKED
         ), claimed AS (
           UPDATE message_image_summaries summary
           SET status = 'processing', attempt_count = attempt_count + 1,
               lease_owner = $1,
               lease_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
               updated_at = NOW()
           FROM candidate WHERE summary.id = candidate.id
           RETURNING summary.*
         )
         SELECT claimed.id, claimed.message_id, message.provider_message_id,
                claimed.source_type, claimed.source_key, claimed.attachment_ref,
                claimed.image_content_hash, claimed.summary, claimed.status,
                claimed.provider_name, claimed.model, claimed.contract_version,
                claimed.attempt_count, claimed.error_code, claimed.duration_ms,
                claimed.generated_at, message.attachments, message.link_previews
         FROM claimed
         INNER JOIN messages message ON message.id = claimed.message_id`,
        [input.leaseOwner, input.leaseMs, input.maxAttempts],
      );
      const row = result.rows[0];
      if (row === undefined) {
        await client.query("COMMIT");
        return null;
      }
      const source = sourceFor(row);
      if (source === null) {
        await client.query(
          `UPDATE message_image_summaries
           SET status = CASE WHEN EXISTS (
                 SELECT 1 FROM messages WHERE id = $2 AND content_redacted_at IS NOT NULL
               ) THEN 'redacted' ELSE 'unavailable' END,
               error_code = 'IMAGE_SUMMARY_SOURCE_UNAVAILABLE',
               lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
           WHERE id = $1 AND lease_owner = $3`,
          [row.id, row.message_id, input.leaseOwner],
        );
        await client.query("COMMIT");
        return null;
      }
      await client.query("COMMIT");
      return {
        id: row.id,
        messageId: row.message_id,
        providerMessageId: row.provider_message_id,
        attemptCount: row.attempt_count,
        ...source,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** All writes lock messages before summaries, matching revision/retention. */
  private async withLockedJob<T>(
    input: { jobId: string; leaseOwner: string },
    unavailable: T,
    action: (db: PoolClient, row: SummaryRow) => Promise<T>,
    additionalMessageIds: readonly string[] = [],
  ): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        `SELECT id FROM messages WHERE id IN (
           SELECT message_id FROM message_image_summaries WHERE id=$1
         ) OR id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
        [input.jobId, additionalMessageIds],
      );
      const found = await db.query<SummaryRow>(
        `SELECT s.*,m.chat_id,m.attachments,m.link_previews FROM message_image_summaries s
         JOIN messages m ON m.id=s.message_id
         WHERE s.id=$1 AND s.status='processing' AND s.lease_owner=$2
           AND s.lease_expires_at>clock_timestamp() AND m.revision_number=0
           AND m.revision_state='active' AND m.content_redacted_at IS NULL
         FOR UPDATE OF s`,
        [input.jobId, input.leaseOwner],
      );
      const row = found.rows[0];
      const result =
        row && sourceFor(row) !== null ? await action(db, row) : unavailable;
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  private async ownsContent(
    db: PoolClient,
    row: SummaryRow,
    input: ImageSummaryContentInput & { contentLeaseToken: string },
  ): Promise<boolean> {
    if (row.content_lease_token !== input.contentLeaseToken) return false;
    const result = await db.query(
      `SELECT 1 FROM image_summary_content_leases
       WHERE chat_id=$1 AND image_content_hash=$2 AND strategy_fingerprint=$3
         AND job_id=$4 AND token=$5 AND expires_at>clock_timestamp() FOR UPDATE`,
      [
        row.chat_id,
        input.imageContentHash,
        input.strategyFingerprint,
        input.jobId,
        input.contentLeaseToken,
      ],
    );
    return result.rowCount === 1;
  }

  async reuse(
    input: ImageSummaryContentInput & {
      durationMs: number;
      contentLeaseToken?: string;
    },
  ): Promise<boolean> {
    const candidate = await this.pool.query<{ id: string; message_id: string }>(
      `SELECT s.id,s.message_id FROM message_image_summaries s
       JOIN messages m ON m.id=s.message_id
       JOIN message_image_summaries target ON target.id=$1
       JOIN messages target_message ON target_message.id=target.message_id
       WHERE m.chat_id=target_message.chat_id AND s.id<>target.id
         AND s.image_content_hash=$2 AND s.strategy_fingerprint=$3
         AND s.status='succeeded' AND length(s.summary)>0
         AND m.revision_number=0 AND m.revision_state='active' AND m.content_redacted_at IS NULL
       ORDER BY s.generated_at DESC,s.id LIMIT 1`,
      [input.jobId, input.imageContentHash, input.strategyFingerprint],
    );
    const source = candidate.rows[0];
    if (!source) return false;
    return this.withLockedJob(
      input,
      false,
      async (db, row) => {
        if (
          input.contentLeaseToken !== undefined &&
          !(await this.ownsContent(db, row, {
            ...input,
            contentLeaseToken: input.contentLeaseToken,
          }))
        )
          return false;
        // Source and target messages are locked in UUID order before either summary.
        const result = await db.query(
          `UPDATE message_image_summaries target
         SET status='succeeded',image_content_hash=source.image_content_hash,
             strategy_fingerprint=source.strategy_fingerprint,summary=source.summary,
             provider_id=source.provider_id,provider_name=source.provider_name,model=source.model,
             contract_version=source.contract_version,generated_at=source.generated_at,
             result_origin='cache',reused_from_id=source.id,reused_at=clock_timestamp(),
             duration_ms=$5,error_code=NULL,lease_owner=NULL,lease_expires_at=NULL,
             content_lease_token=NULL,updated_at=clock_timestamp()
         FROM message_image_summaries source JOIN messages m ON m.id=source.message_id
         WHERE target.id=$1 AND source.id=$2 AND m.chat_id=$6
           AND source.status='succeeded' AND length(source.summary)>0
           AND source.image_content_hash=$3 AND source.strategy_fingerprint=$4
           AND m.revision_number=0 AND m.revision_state='active' AND m.content_redacted_at IS NULL
           AND target.lease_expires_at>clock_timestamp()`,
          [
            input.jobId,
            source.id,
            input.imageContentHash,
            input.strategyFingerprint,
            input.durationMs,
            row.chat_id,
          ],
        );
        return result.rowCount === 1;
      },
      [source.message_id],
    );
  }

  async acquireContentLease(
    input: ImageSummaryContentInput,
  ): Promise<
    | { status: "acquired"; token: string }
    | { status: "waiting" }
    | { status: "invalid" }
  > {
    return this.withLockedJob<
      | { status: "acquired"; token: string }
      | { status: "waiting" }
      | { status: "invalid" }
    >(input, { status: "invalid" }, async (db, row) => {
      const token = randomUUID();
      const acquired = await db.query(
        `INSERT INTO image_summary_content_leases(chat_id,image_content_hash,strategy_fingerprint,job_id,token,expires_at)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(chat_id,image_content_hash,strategy_fingerprint) DO UPDATE
         SET job_id=EXCLUDED.job_id,token=EXCLUDED.token,expires_at=EXCLUDED.expires_at
         WHERE image_summary_content_leases.expires_at<=clock_timestamp()
         RETURNING token`,
        [
          row.chat_id,
          input.imageContentHash,
          input.strategyFingerprint,
          input.jobId,
          token,
          row.lease_expires_at,
        ],
      );
      await db.query(
        `UPDATE message_image_summaries SET image_content_hash=$2,
         content_lease_token=$3,updated_at=clock_timestamp() WHERE id=$1`,
        [
          input.jobId,
          input.imageContentHash,
          acquired.rowCount === 1 ? token : null,
        ],
      );
      return acquired.rowCount === 1
        ? { status: "acquired", token }
        : { status: "waiting" };
    });
  }

  async releaseContentLease(input: {
    jobId: string;
    token: string;
  }): Promise<void> {
    await this.pool.query(
      "DELETE FROM image_summary_content_leases WHERE job_id=$1 AND token=$2",
      [input.jobId, input.token],
    );
  }

  async canGenerate(
    input: ImageSummaryContentInput & { contentLeaseToken: string },
  ): Promise<boolean> {
    return this.withLockedJob(input, false, (db, row) =>
      this.ownsContent(db, row, input),
    );
  }

  async deferForContent(input: {
    jobId: string;
    leaseOwner: string;
  }): Promise<boolean> {
    return this.withLockedJob(input, false, async (db) => {
      const result = await db.query(
        `UPDATE message_image_summaries SET status='pending',attempt_count=GREATEST(0,attempt_count-1),
         content_wait_count=content_wait_count+1,next_attempt_at=clock_timestamp()+interval '5 seconds',
         lease_owner=NULL,lease_expires_at=NULL,content_lease_token=NULL,error_code=NULL,updated_at=clock_timestamp()
         WHERE id=$1`,
        [input.jobId],
      );
      return result.rowCount === 1;
    });
  }

  async complete(input: ImageSummaryCompletion): Promise<boolean> {
    return this.withLockedJob(input, false, async (db, row) => {
      if (!(await this.ownsContent(db, row, input))) return false;
      const result = await db.query(
        `UPDATE message_image_summaries
         SET status='succeeded',image_content_hash=$3,summary=$4,
             provider_id=$5,provider_name=$6,model=$7,duration_ms=$8,
             strategy_fingerprint=$9,result_origin='model',reused_from_id=NULL,reused_at=NULL,
             error_code=NULL,lease_owner=NULL,lease_expires_at=NULL,content_lease_token=NULL,
             generated_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE id=$1 AND lease_owner=$2 AND lease_expires_at>clock_timestamp()`,
        [
          input.jobId,
          input.leaseOwner,
          input.imageContentHash,
          input.summary,
          input.providerId,
          input.providerName,
          input.model,
          input.durationMs,
          input.strategyFingerprint,
        ],
      );
      return result.rowCount === 1;
    });
  }

  async renewLease(input: {
    jobId: string;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<boolean> {
    return this.withLockedJob(input, false, async (db, row) => {
      if (row.content_lease_token !== null) {
        const renewed = await db.query(
          `UPDATE image_summary_content_leases SET expires_at=clock_timestamp()+($3*interval '1 millisecond')
           WHERE job_id=$1 AND token=$2 AND expires_at>clock_timestamp()`,
          [input.jobId, row.content_lease_token, input.leaseMs],
        );
        if (renewed.rowCount !== 1) return false;
      }
      await db.query(
        `UPDATE message_image_summaries SET lease_expires_at=clock_timestamp()+($2*interval '1 millisecond'),
         updated_at=clock_timestamp() WHERE id=$1`,
        [input.jobId, input.leaseMs],
      );
      return true;
    });
  }

  async fail(input: {
    jobId: string;
    leaseOwner: string;
    status: "pending" | "failed" | "unavailable";
    errorCode: string;
    durationMs: number;
    nextAttemptAt: Date;
  }): Promise<boolean> {
    return this.withLockedJob(input, false, async (db) => {
      const result = await db.query(
        `UPDATE message_image_summaries SET status=$3,error_code=$4,duration_ms=$5,
         next_attempt_at=$6,lease_owner=NULL,lease_expires_at=NULL,content_lease_token=NULL,updated_at=clock_timestamp()
         WHERE id=$1 AND lease_owner=$2`,
        [
          input.jobId,
          input.leaseOwner,
          input.status,
          input.errorCode,
          input.durationMs,
          input.nextAttemptAt,
        ],
      );
      return result.rowCount === 1;
    });
  }

  async listForMessageIds(
    messageIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly MessageImageSummary[]>> {
    if (messageIds.length === 0) return new Map();
    const result = await this.pool.query<SummaryRow>(
      `${summarySelect}
       WHERE summary.message_id = ANY($1::uuid[])
       ORDER BY summary.message_id, summary.created_at, summary.id`,
      [messageIds],
    );
    const grouped = new Map<string, MessageImageSummary[]>();
    for (const row of result.rows) {
      const current = grouped.get(row.message_id) ?? [];
      current.push(summaryView(row));
      grouped.set(row.message_id, current);
    }
    return grouped;
  }

  async listForProviderMessageIds(
    providerMessageIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly MessageImageSummary[]>> {
    if (providerMessageIds.length === 0) return new Map();
    const result = await this.pool.query<SummaryRow>(
      `${summarySelect}
       WHERE message.provider_message_id = ANY($1::text[])
       ORDER BY message.provider_message_id, summary.created_at, summary.id`,
      [providerMessageIds],
    );
    const grouped = new Map<string, MessageImageSummary[]>();
    for (const row of result.rows) {
      const current = grouped.get(row.provider_message_id) ?? [];
      current.push(summaryView(row));
      grouped.set(row.provider_message_id, current);
    }
    return grouped;
  }

  async isReady(): Promise<boolean> {
    const result = await this.pool.query<{ ready: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM schema_migrations
         WHERE name = '0076_image_summary_reuse.sql'
       ) AS ready`,
    );
    return result.rows[0]?.ready === true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
