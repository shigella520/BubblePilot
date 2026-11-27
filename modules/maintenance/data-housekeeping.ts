import type { Pool } from "pg";

/**
 * Periodic cleanup of derived and diagnostic data that otherwise grows
 * forever (doc/迭代需求-性能优化.md, P3). Each step is bounded and isolated:
 * one failing step never blocks the others, and nothing touches message
 * content, workflow history or index rows that are still current.
 */
export interface HousekeepingResult {
  step: string;
  rows: number;
}

const batch = 5000;

export const housekeepingSteps: ReadonlyArray<{ step: string; sql: string }> = [
  {
    // Invalidated chunks are never reused as-is; vectors and sources cascade.
    step: "invalid-memory-chunks",
    sql: `DELETE FROM memory_chunks WHERE id IN (
        SELECT id FROM memory_chunks WHERE NOT valid LIMIT ${batch})`,
  },
  {
    step: "finished-memory-job-items",
    sql: `DELETE FROM memory_job_items WHERE (job_id, message_id) IN (
        SELECT i.job_id, i.message_id FROM memory_job_items i
        JOIN memory_jobs j ON j.id = i.job_id
        WHERE j.status IN ('succeeded','cancelled','superseded')
          AND j.updated_at < now() - interval '7 days'
        LIMIT ${batch * 4})`,
  },
  {
    // Finished new-message jobs are only audit noise after a week; failed,
    // backfill and rebuild jobs are kept (failed ones define index gaps).
    step: "finished-incremental-memory-jobs",
    sql: `DELETE FROM memory_jobs WHERE id IN (
        SELECT id FROM memory_jobs
        WHERE reason = 'incremental'
          AND status IN ('succeeded','cancelled','superseded')
          AND updated_at < now() - interval '7 days'
        LIMIT ${batch})`,
  },
  {
    // A session row stays 'started' when the search tool was never used.
    step: "unused-memory-retrievals",
    sql: `DELETE FROM memory_retrievals WHERE id IN (
        SELECT id FROM memory_retrievals
        WHERE status = 'started' AND created_at < now() - interval '1 hour'
        LIMIT ${batch})`,
  },
  {
    // Same horizon as execution history, so “view sources” keeps working.
    step: "old-memory-retrievals",
    sql: `DELETE FROM memory_retrievals WHERE id IN (
        SELECT id FROM memory_retrievals
        WHERE created_at < now() - interval '90 days'
        LIMIT ${batch})`,
  },
  {
    step: "finished-attribution-jobs",
    sql: `DELETE FROM bot_attribution_jobs WHERE id IN (
        SELECT id FROM bot_attribution_jobs
        WHERE status = 'succeeded' AND updated_at < now() - interval '30 days'
        LIMIT ${batch})`,
  },
  {
    // Request structure traces are for recent cache diagnosis; token usage
    // and attempt metadata stay for usage reports.
    step: "old-request-traces",
    sql: `UPDATE ai_provider_attempts SET request_trace = NULL WHERE id IN (
        SELECT id FROM ai_provider_attempts
        WHERE request_trace IS NOT NULL
          AND created_at < now() - interval '30 days'
        LIMIT 500)`,
  },
  {
    // Finished executions keep their row, deliveries, attributions and usage
    // counts; node / tool / route / image-input details expire with the
    // configured execution detail retention (default 90 days).
    step: "old-execution-details",
    sql: `WITH target AS (
        SELECT id FROM workflow_executions
        WHERE details_purged_at IS NULL AND completed_at IS NOT NULL
          AND completed_at < now() - make_interval(days => COALESCE(
            (SELECT execution_detail_days FROM data_retention_settings WHERE id = 1), 90))
        ORDER BY completed_at LIMIT 200),
      nodes AS (DELETE FROM node_executions WHERE execution_id IN (SELECT id FROM target)),
      tools AS (DELETE FROM ai_tool_executions WHERE execution_id IN (SELECT id FROM target)),
      routes AS (DELETE FROM ai_route_traces WHERE execution_id IN (SELECT id FROM target)),
      images AS (DELETE FROM ai_image_inputs WHERE execution_id IN (SELECT id FROM target))
      UPDATE workflow_executions SET details_purged_at = now() WHERE id IN (SELECT id FROM target)`,
  },
];

/** Housekeeping work that needs application code rather than one statement. */
export interface HousekeepingTask {
  step: string;
  run: () => Promise<number>;
}

export class DataHousekeeping {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  constructor(
    private readonly pool: Pick<Pool, "query">,
    private readonly report: (results: HousekeepingResult[]) => void = () =>
      undefined,
    private readonly intervalMs = 10 * 60 * 1000,
    private readonly tasks: readonly HousekeepingTask[] = [],
  ) {}

  async runOnce(): Promise<HousekeepingResult[]> {
    const results: HousekeepingResult[] = [];
    for (const { step, sql } of housekeepingSteps) {
      try {
        const result = await this.pool.query(sql);
        results.push({ step, rows: result.rowCount ?? 0 });
      } catch {
        // Missing optional tables (memory not prepared) or a transient error
        // must not stop the remaining steps; the next run retries.
        results.push({ step, rows: -1 });
      }
    }
    for (const { step, run } of this.tasks) {
      try {
        results.push({ step, rows: await run() });
      } catch {
        results.push({ step, rows: -1 });
      }
    }
    if (results.some((r) => r.rows !== 0)) this.report(results);
    return results;
  }

  start() {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = this.runOnce()
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          this.running = null;
        });
    };
    // First pass shortly after startup, then every interval.
    setTimeout(tick, 60_000).unref();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
