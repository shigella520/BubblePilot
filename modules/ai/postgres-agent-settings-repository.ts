import type { Pool } from "pg";

import { createPostgresPool } from "../shared/postgres-pool.js";

import type {
  AgentSettingsRecord,
  AgentSettingsRepository,
} from "./agent-settings-repository.js";

interface SettingsRow {
  max_tool_calls: number;
  max_tool_output_characters: number;
  max_tool_duration_ms: number;
  version: number;
  updated_at: Date;
}

const returning = `max_tool_calls, max_tool_output_characters, max_tool_duration_ms, version, updated_at`;

function record(row: SettingsRow): AgentSettingsRecord {
  return {
    maxToolCalls: row.max_tool_calls,
    maxToolOutputCharacters: row.max_tool_output_characters,
    maxToolDurationMs: row.max_tool_duration_ms,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresAgentSettingsRepository implements AgentSettingsRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string, queryTimeoutMs?: number) {
    this.pool = createPostgresPool(databaseUrl, 3, queryTimeoutMs);
  }

  async find(): Promise<AgentSettingsRecord | null> {
    const result = await this.pool.query<SettingsRow>(
      `SELECT ${returning} FROM ai_agent_settings WHERE id = 1`,
    );
    const row = result.rows[0];
    return row === undefined ? null : record(row);
  }

  async save(
    input: Parameters<AgentSettingsRepository["save"]>[0],
  ): ReturnType<AgentSettingsRepository["save"]> {
    const values = [
      input.maxToolCalls,
      input.maxToolOutputCharacters,
      input.maxToolDurationMs,
    ];
    const result =
      input.expectedVersion === 0
        ? await this.pool.query<SettingsRow>(
            `INSERT INTO ai_agent_settings (
               id, max_tool_calls, max_tool_output_characters, max_tool_duration_ms
             ) VALUES (1, $1, $2, $3)
             ON CONFLICT (id) DO NOTHING
             RETURNING ${returning}`,
            values,
          )
        : await this.pool.query<SettingsRow>(
            `UPDATE ai_agent_settings
             SET max_tool_calls = $1,
                 max_tool_output_characters = $2,
                 max_tool_duration_ms = $3,
                 version = version + 1,
                 updated_at = NOW()
             WHERE id = 1 AND version = $4
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
         WHERE name = '0048_ai_agent_settings.sql'
       ) AS present`,
    );
    return result.rows[0]?.present ?? false;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
