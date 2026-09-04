import type { Pool } from "pg";

import { createPostgresPool } from "../shared/postgres-pool.js";

import type { WebSearchFailurePolicy } from "./ai-types.js";
import type {
  WebSearchSettingsRecord,
  WebSearchSettingsRepository,
} from "./web-search-settings-repository.js";

interface SettingsRow {
  max_attempts: number;
  attempt_timeout_ms: number;
  retry_delay_ms: number;
  max_results: number;
  failure_policy: WebSearchFailurePolicy;
  version: number;
  updated_at: Date;
}

const returning = `max_attempts, attempt_timeout_ms, retry_delay_ms,
                    max_results, failure_policy,
                    version, updated_at`;

function record(row: SettingsRow): WebSearchSettingsRecord {
  return {
    maxAttempts: row.max_attempts,
    attemptTimeoutMs: row.attempt_timeout_ms,
    retryDelayMs: row.retry_delay_ms,
    maxResults: row.max_results,
    failurePolicy: row.failure_policy,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresWebSearchSettingsRepository implements WebSearchSettingsRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string, queryTimeoutMs?: number) {
    this.pool = createPostgresPool(databaseUrl, 3, queryTimeoutMs);
  }

  async find(): Promise<WebSearchSettingsRecord | null> {
    const result = await this.pool.query<SettingsRow>(
      `SELECT ${returning} FROM ai_web_search_settings WHERE id = 1`,
    );
    const row = result.rows[0];
    return row === undefined ? null : record(row);
  }

  async save(
    input: Parameters<WebSearchSettingsRepository["save"]>[0],
  ): ReturnType<WebSearchSettingsRepository["save"]> {
    const values = [
      input.maxAttempts,
      input.attemptTimeoutMs,
      input.retryDelayMs,
      input.maxResults,
      input.failurePolicy,
    ];
    const result =
      input.expectedVersion === 0
        ? await this.pool.query<SettingsRow>(
            `INSERT INTO ai_web_search_settings (
               id, max_attempts, attempt_timeout_ms,
               retry_delay_ms, max_results, failure_policy
             ) VALUES (1, $1, $2, $3, $4, $5)
             ON CONFLICT (id) DO NOTHING
             RETURNING ${returning}`,
            values,
          )
        : await this.pool.query<SettingsRow>(
            `UPDATE ai_web_search_settings
             SET max_attempts = $1,
                 attempt_timeout_ms = $2,
                 retry_delay_ms = $3,
                 max_results = $4,
                 failure_policy = $5,
                 version = version + 1,
                 updated_at = NOW()
             WHERE id = 1 AND version = $6
             RETURNING ${returning}`,
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
         WHERE name = '0021_ai_web_search_settings.sql'
       ) AS present`,
    );
    return result.rows[0]?.present ?? false;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
