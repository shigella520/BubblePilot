import type { Pool } from "pg";
import { createPostgresPool } from "../shared/postgres-pool.js";
import type {
  ContextSettingsRecord,
  ContextSettingsRepository,
} from "./context-settings-repository.js";
import type { ContextSettingsUpdate } from "./context-settings-types.js";

interface Row {
  include_from_me: boolean;
  base_message_window: number;
  character_limit: number;
  redundancy_message_window: number;
  version: number;
  updated_at: Date;
}
const cols =
  "include_from_me, base_message_window, character_limit, redundancy_message_window, version, updated_at";
function map(row: Row): ContextSettingsRecord {
  return {
    includeFromMe: row.include_from_me,
    baseMessageWindow: row.base_message_window,
    characterLimit: row.character_limit,
    redundancyMessageWindow: row.redundancy_message_window,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}
export class PostgresContextSettingsRepository implements ContextSettingsRepository {
  private readonly pool: Pool;
  constructor(databaseUrl: string, timeout?: number) {
    this.pool = createPostgresPool(databaseUrl, 3, timeout);
  }
  close(): Promise<void> {
    return this.pool.end();
  }
  async isReady(): Promise<boolean> {
    try {
      await this.pool.query(
        "SELECT 1 FROM conversation_context_settings LIMIT 1",
      );
      return true;
    } catch {
      return false;
    }
  }
  async find() {
    const result = await this.pool.query<Row>(
      `SELECT ${cols} FROM conversation_context_settings WHERE id = 1`,
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async save(input: ContextSettingsUpdate) {
    const values = [
      input.includeFromMe,
      input.baseMessageWindow,
      input.characterLimit,
      input.redundancyMessageWindow,
    ];
    const result =
      input.expectedVersion === 0
        ? await this.pool.query<Row>(
            `INSERT INTO conversation_context_settings (id, include_from_me, base_message_window, character_limit, redundancy_message_window) VALUES (1,$1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING ${cols}`,
            values,
          )
        : await this.pool.query<Row>(
            `UPDATE conversation_context_settings SET include_from_me=$1,base_message_window=$2,character_limit=$3,redundancy_message_window=$4,version=version+1,updated_at=NOW() WHERE id=1 AND version=$5 RETURNING ${cols}`,
            [...values, input.expectedVersion],
          );
    return result.rows[0]
      ? { status: "ok" as const, value: map(result.rows[0]) }
      : { status: "conflict" as const };
  }
}
