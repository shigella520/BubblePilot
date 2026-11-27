import type { Pool } from "pg";
import { z } from "zod";
import { ApplicationError } from "../../app/errors.js";

export const minExecutionDetailDays = 7;
export const maxExecutionDetailDays = 3650;
export const defaultExecutionDetailDays = 90;

export const dataRetentionUpdateSchema = z
  .object({
    executionDetailDays: z
      .number()
      .int()
      .min(minExecutionDetailDays)
      .max(maxExecutionDetailDays),
    expectedVersion: z.number().int().min(1),
  })
  .strict();

export interface DataRetentionView {
  executionDetailDays: number;
  version: number;
  updatedAt: string | null;
}

/** Retention of execution details, enforced by DataHousekeeping. */
export class DataRetentionSettingsRepository {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async view(): Promise<DataRetentionView> {
    const row = (
      await this.pool.query<{
        execution_detail_days: number;
        version: number;
        updated_at: Date;
      }>("SELECT * FROM data_retention_settings WHERE id = 1")
    ).rows[0];
    return {
      executionDetailDays:
        row?.execution_detail_days ?? defaultExecutionDetailDays,
      version: row?.version ?? 0,
      updatedAt: row?.updated_at.toISOString() ?? null,
    };
  }

  async update(input: unknown): Promise<DataRetentionView> {
    const body = dataRetentionUpdateSchema.parse(input);
    // The migration creates the single row, so a save always updates it.
    const updated = await this.pool.query(
      `UPDATE data_retention_settings SET execution_detail_days = $1,
         version = version + 1, updated_at = now()
       WHERE id = 1 AND version = $2`,
      [body.executionDetailDays, body.expectedVersion],
    );
    if (!updated.rowCount)
      throw new ApplicationError(
        "DATA_RETENTION_VERSION_CONFLICT",
        "Refresh data retention settings before saving.",
        409,
      );
    return this.view();
  }
}
