import type { Pool } from "pg";
import { createPostgresPool } from "../shared/postgres-pool.js";
import type {
  SummarySettingsRecord,
  SummarySettingsRepository,
} from "./summary-settings-repository.js";
import type { SummarySettingsUpdate } from "./summary-settings-types.js";

interface Row {
  enabled: boolean;
  include_from_me: boolean;
  base_message_window: number;
  character_limit: number;
  redundancy_message_window: number;
  provider_route_id: string | null;
  time_zone: string;
  version: number;
  policy_version: number;
  updated_at: Date;
}
const cols =
  "enabled, include_from_me, base_message_window, character_limit, redundancy_message_window, provider_route_id, time_zone, version, policy_version, updated_at";
function map(row: Row): SummarySettingsRecord {
  return {
    enabled: row.enabled,
    includeFromMe: row.include_from_me,
    baseMessageWindow: row.base_message_window,
    characterLimit: row.character_limit,
    redundancyMessageWindow: row.redundancy_message_window,
    providerRouteId: row.provider_route_id ?? "",
    timeZone: row.time_zone,
    version: row.version,
    policyVersion: row.policy_version,
    updatedAt: row.updated_at.toISOString(),
  };
}
export class PostgresSummarySettingsRepository implements SummarySettingsRepository {
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
        "SELECT 1 FROM conversation_summary_settings LIMIT 1",
      );
      return true;
    } catch {
      return false;
    }
  }
  async find() {
    const result = await this.pool.query<Row>(
      `SELECT ${cols} FROM conversation_summary_settings WHERE id = 1`,
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async save(input: SummarySettingsUpdate) {
    const values = [
      input.enabled,
      input.includeFromMe,
      input.baseMessageWindow,
      input.characterLimit,
      input.redundancyMessageWindow,
      input.providerRouteId || null,
      input.timeZone,
    ];
    const result =
      input.expectedVersion === 0
        ? await this.pool.query<Row>(
            `INSERT INTO conversation_summary_settings (id, enabled, include_from_me, base_message_window, character_limit, redundancy_message_window, provider_route_id, time_zone) VALUES (1,$1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING ${cols}`,
            values,
          )
        : await this.pool.query<Row>(
            `UPDATE conversation_summary_settings SET enabled=$1,include_from_me=$2,base_message_window=$3,character_limit=$4,redundancy_message_window=$5,provider_route_id=$6,time_zone=$7,version=version+1,updated_at=NOW() WHERE id=1 AND version=$8 RETURNING ${cols}`,
            [...values, input.expectedVersion],
          );
    return result.rows[0]
      ? { status: "ok" as const, value: map(result.rows[0]) }
      : { status: "conflict" as const };
  }
}
