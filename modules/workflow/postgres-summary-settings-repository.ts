import type { Pool } from "pg";
import { createPostgresPool } from "../shared/postgres-pool.js";
import type {
  SummarySettingsRecord,
  SummarySettingsRepository,
} from "./summary-settings-repository.js";
import type { SummarySettingsUpdate } from "./summary-settings-types.js";

interface Row {
  enabled: boolean;
  message_limit: number;
  character_limit: number;
  compression_batch_size: number;
  provider_route_id: string | null;
  time_zone: string;
  version: number;
  policy_version: number;
  updated_at: Date;
}
const cols =
  "enabled, message_limit, character_limit, compression_batch_size, provider_route_id, time_zone, version, policy_version, updated_at";
function map(row: Row): SummarySettingsRecord {
  return {
    enabled: row.enabled,
    messageLimit: row.message_limit,
    characterLimit: row.character_limit,
    compressionBatchSize: row.compression_batch_size,
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
  async find() {
    const result = await this.pool.query<Row>(
      `SELECT ${cols} FROM conversation_summary_settings WHERE id = 1`,
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async save(input: SummarySettingsUpdate) {
    const values = [
      input.enabled,
      input.messageLimit,
      input.characterLimit,
      input.compressionBatchSize,
      input.providerRouteId || null,
      input.timeZone,
    ];
    const result =
      input.expectedVersion === 0
        ? await this.pool.query<Row>(
            `INSERT INTO conversation_summary_settings (id, enabled, message_limit, character_limit, compression_batch_size, provider_route_id, time_zone) VALUES (1,$1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING RETURNING ${cols}`,
            values,
          )
        : await this.pool.query<Row>(
            `UPDATE conversation_summary_settings SET enabled=$1,message_limit=$2,character_limit=$3,compression_batch_size=$4,provider_route_id=$5,time_zone=$6,version=version+1,policy_version=policy_version+1,updated_at=NOW() WHERE id=1 AND version=$7 RETURNING ${cols}`,
            [...values, input.expectedVersion],
          );
    return result.rows[0]
      ? { status: "ok" as const, value: map(result.rows[0]) }
      : { status: "conflict" as const };
  }
}
