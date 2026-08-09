import type { Pool } from "pg";

import { createPostgresPool } from "../shared/postgres-pool.js";
import type {
  ImageInputSettingsRecord,
  ImageInputSettingsRepository,
} from "./image-input-settings-repository.js";
import type { ImageDetail } from "./image-input-settings-types.js";

interface SettingsRow {
  enabled: boolean;
  include_attachments: boolean;
  include_link_preview_images: boolean;
  max_current_attachments: number;
  max_history_images: number;
  max_total_images: number;
  max_image_bytes: number;
  max_total_bytes: number;
  fetch_timeout_ms: number;
  detail: ImageDetail;
  version: number;
  updated_at: Date;
}

const returning = `enabled, include_attachments, include_link_preview_images,
  max_current_attachments, max_history_images, max_total_images,
  max_image_bytes, max_total_bytes, fetch_timeout_ms, detail,
  version, updated_at`;

function record(row: SettingsRow): ImageInputSettingsRecord {
  return {
    enabled: row.enabled,
    includeAttachments: row.include_attachments,
    includeLinkPreviewImages: row.include_link_preview_images,
    maxCurrentAttachments: row.max_current_attachments,
    maxHistoryImages: row.max_history_images,
    maxTotalImages: row.max_total_images,
    maxImageBytes: row.max_image_bytes,
    maxTotalBytes: row.max_total_bytes,
    fetchTimeoutMs: row.fetch_timeout_ms,
    detail: row.detail,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresImageInputSettingsRepository implements ImageInputSettingsRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string, queryTimeoutMs?: number) {
    this.pool = createPostgresPool(databaseUrl, 3, queryTimeoutMs);
  }

  async find(): Promise<ImageInputSettingsRecord | null> {
    const result = await this.pool.query<SettingsRow>(
      `SELECT ${returning} FROM ai_image_input_settings WHERE id = 1`,
    );
    const row = result.rows[0];
    return row === undefined ? null : record(row);
  }

  async save(
    input: Parameters<ImageInputSettingsRepository["save"]>[0],
  ): ReturnType<ImageInputSettingsRepository["save"]> {
    const values = [
      input.enabled,
      input.includeAttachments,
      input.includeLinkPreviewImages,
      input.maxCurrentAttachments,
      input.maxHistoryImages,
      input.maxTotalImages,
      input.maxImageBytes,
      input.maxTotalBytes,
      input.fetchTimeoutMs,
      input.detail,
    ];
    const result =
      input.expectedVersion === 0
        ? await this.pool.query<SettingsRow>(
            `INSERT INTO ai_image_input_settings (
               id, enabled, include_attachments, include_link_preview_images,
               max_current_attachments, max_history_images, max_total_images,
               max_image_bytes, max_total_bytes, fetch_timeout_ms, detail
             ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (id) DO NOTHING RETURNING ${returning}`,
            values,
          )
        : await this.pool.query<SettingsRow>(
            `UPDATE ai_image_input_settings SET
               enabled = $1, include_attachments = $2,
               include_link_preview_images = $3, max_current_attachments = $4,
               max_history_images = $5, max_total_images = $6,
               max_image_bytes = $7, max_total_bytes = $8,
               fetch_timeout_ms = $9, detail = $10,
               version = version + 1, updated_at = NOW()
             WHERE id = 1 AND version = $11 RETURNING ${returning}`,
            [...values, input.expectedVersion],
          );
    const row = result.rows[0];
    return row === undefined
      ? { status: "conflict" }
      : { status: "ok", value: record(row) };
  }

  async isReady(): Promise<boolean> {
    const result = await this.pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM schema_migrations
         WHERE name = '0024_ai_image_input.sql'
       ) AS present`,
    );
    return result.rows[0]?.present ?? false;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
