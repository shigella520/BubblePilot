import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

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
  ImageSummaryJob,
  ImageSummarySource,
  ImageSummaryStatus,
  MessageImageSummary,
} from "./image-summary-types.js";

interface SummaryRow {
  id: string;
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
  summary.duration_ms, summary.generated_at,
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
       ) VALUES ($1, $2, $3, $4, $5, 'pending')
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE message_image_summaries
         SET status = CASE WHEN attempt_count >= $1 THEN 'failed' ELSE 'pending' END,
             error_code = 'IMAGE_SUMMARY_LEASE_EXPIRED', lease_owner = NULL,
             lease_expires_at = NULL, next_attempt_at = NOW(), updated_at = NOW()
         WHERE status = 'processing' AND lease_expires_at <= NOW()`,
        [input.maxAttempts],
      );
      const result = await client.query<SummaryRow>(
        `WITH candidate AS (
           SELECT id FROM message_image_summaries
           WHERE status = 'pending' AND next_attempt_at <= NOW()
             AND attempt_count < $3
           ORDER BY next_attempt_at, created_at, id
           LIMIT 1 FOR UPDATE SKIP LOCKED
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

  async complete(input: ImageSummaryCompletion): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE message_image_summaries
       SET status = 'succeeded', image_content_hash = $3, summary = $4,
           provider_id = $5, provider_name = $6, model = $7,
           duration_ms = $8, error_code = NULL, lease_owner = NULL,
           lease_expires_at = NULL, generated_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'processing' AND lease_owner = $2
         AND lease_expires_at > NOW()`,
      [
        input.jobId,
        input.leaseOwner,
        input.imageContentHash,
        input.summary,
        input.providerId,
        input.providerName,
        input.model,
        input.durationMs,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async renewLease(input: {
    jobId: string;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE message_image_summaries
       SET lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE id = $1 AND status = 'processing' AND lease_owner = $2
         AND lease_expires_at > NOW()`,
      [input.jobId, input.leaseOwner, input.leaseMs],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async fail(input: {
    jobId: string;
    leaseOwner: string;
    status: "pending" | "failed" | "unavailable";
    errorCode: string;
    durationMs: number;
    nextAttemptAt: Date;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE message_image_summaries
       SET status = $3, error_code = $4, duration_ms = $5,
           next_attempt_at = $6, lease_owner = NULL, lease_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND status = 'processing' AND lease_owner = $2`,
      [
        input.jobId,
        input.leaseOwner,
        input.status,
        input.errorCode,
        input.durationMs,
        input.nextAttemptAt,
      ],
    );
    return (result.rowCount ?? 0) === 1;
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
         WHERE name = '0033_message_image_summaries.sql'
       ) AS ready`,
    );
    return result.rows[0]?.ready === true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
