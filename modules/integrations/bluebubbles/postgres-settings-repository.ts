import type { Pool } from "pg";

import { createPostgresPool } from "../../shared/postgres-pool.js";

import type {
  BlueBubblesSettingsRecord,
  BlueBubblesSettingsRepository,
} from "./settings-repository.js";

interface SettingsRow {
  server_url: string;
  encrypted_access_token: string;
  encrypted_webhook_secret: string;
  send_method: "private-api" | "apple-script";
  request_timeout_ms: number;
  version: number;
  updated_at: Date;
}

function record(row: SettingsRow): BlueBubblesSettingsRecord {
  return {
    serverUrl: row.server_url,
    encryptedAccessToken: row.encrypted_access_token,
    encryptedWebhookSecret: row.encrypted_webhook_secret,
    sendMethod: row.send_method,
    requestTimeoutMs: row.request_timeout_ms,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresBlueBubblesSettingsRepository implements BlueBubblesSettingsRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string, queryTimeoutMs?: number) {
    this.pool = createPostgresPool(databaseUrl, 5, queryTimeoutMs);
  }

  async find(): Promise<BlueBubblesSettingsRecord | null> {
    const result = await this.pool.query<SettingsRow>(
      `SELECT server_url, encrypted_access_token, encrypted_webhook_secret,
              send_method, request_timeout_ms, version, updated_at
       FROM bluebubbles_settings WHERE id = 1`,
    );
    return result.rows[0] === undefined ? null : record(result.rows[0]);
  }

  async save(input: {
    serverUrl: string;
    encryptedAccessToken: string;
    encryptedWebhookSecret: string;
    sendMethod: "private-api" | "apple-script";
    requestTimeoutMs: number;
    expectedVersion: number;
  }): Promise<
    { status: "ok"; value: BlueBubblesSettingsRecord } | { status: "conflict" }
  > {
    const result =
      input.expectedVersion === 0
        ? await this.pool.query<SettingsRow>(
            `INSERT INTO bluebubbles_settings (
               id, server_url, encrypted_access_token,
               encrypted_webhook_secret, send_method, request_timeout_ms
             ) VALUES (1, $1, $2, $3, $4, $5)
             ON CONFLICT (id) DO NOTHING
             RETURNING server_url, encrypted_access_token,
                       encrypted_webhook_secret, send_method,
                       request_timeout_ms, version, updated_at`,
            [
              input.serverUrl,
              input.encryptedAccessToken,
              input.encryptedWebhookSecret,
              input.sendMethod,
              input.requestTimeoutMs,
            ],
          )
        : await this.pool.query<SettingsRow>(
            `UPDATE bluebubbles_settings
             SET server_url = $1,
                 encrypted_access_token = $2,
                 encrypted_webhook_secret = $3,
                 send_method = $4,
                 request_timeout_ms = $5,
                 version = version + 1,
                 updated_at = NOW()
             WHERE id = 1 AND version = $6
             RETURNING server_url, encrypted_access_token,
                       encrypted_webhook_secret, send_method,
                       request_timeout_ms, version, updated_at`,
            [
              input.serverUrl,
              input.encryptedAccessToken,
              input.encryptedWebhookSecret,
              input.sendMethod,
              input.requestTimeoutMs,
              input.expectedVersion,
            ],
          );
    const row = result.rows[0];
    return row === undefined
      ? { status: "conflict" }
      : { status: "ok", value: record(row) };
  }

  async isReady(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ ready: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM schema_migrations
           WHERE name = '0010_bluebubbles_settings.sql'
         ) AS ready`,
      );
      return result.rows[0]?.ready === true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
