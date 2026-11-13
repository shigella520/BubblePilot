import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createPostgresPool } from "../shared/postgres-pool.js";

const lockName = "bubblepilot:workflow-runtime:v1";
const interrupted = "WORKFLOW_PROCESS_INTERRUPTED";
const reason = "原执行进程已结束，服务启动时自动关闭，未重新执行。";
export interface StartupRecoveryReport {
  runId: string;
  boundary: string;
  scanned: number;
  closed: number;
  deferred: number;
  interruptedNodes: number;
  unknownDeliveries: number;
}

/** A dedicated session owns the single-process runtime until shutdown finishes. */
export class WorkflowStartupRecovery {
  private readonly pool: Pool;
  private client: PoolClient | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private healthy = false;
  private stopping = false;
  private probing = false;
  constructor(
    databaseUrl: string,
    queryTimeoutMs: number,
    private readonly onLost: () => void,
  ) {
    this.pool = createPostgresPool(
      databaseUrl,
      1,
      Math.min(queryTimeoutMs, 5000),
    );
  }
  private readonly lost = () => {
    if (!this.healthy || this.stopping) return;
    this.healthy = false;
    clearInterval(this.heartbeat);
    this.onLost();
  };
  async start(batchSize = 100): Promise<StartupRecoveryReport> {
    if (
      this.client ||
      this.stopping ||
      !Number.isInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 500
    )
      throw new Error("INVALID_STARTUP_RECOVERY_STATE");
    try {
      this.client = await this.pool.connect();
      this.client.on("error", this.lost);
      this.client.on("end", this.lost);
      const acquired = await this.client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
        [lockName],
      );
      if (!acquired.rows[0]?.acquired)
        throw new Error("WORKFLOW_RUNTIME_ALREADY_ACTIVE");
      this.healthy = true;
      const boundary = (
        await this.client.query<{ boundary: string }>(
          "SELECT clock_timestamp()::text AS boundary",
        )
      ).rows[0]!.boundary;
      const report: StartupRecoveryReport = {
        runId: randomUUID(),
        boundary,
        scanned: 0,
        closed: 0,
        deferred: 0,
        interruptedNodes: 0,
        unknownDeliveries: 0,
      };
      let cursor: string | null = null;
      for (;;) {
        if (!this.healthy) throw new Error("WORKFLOW_RUNTIME_LOCK_LOST");
        await this.client.query("BEGIN");
        try {
          const rows: Array<{ id: string; status: string; managed: boolean }> =
            (
              await this.client.query<{
                id: string;
                status: string;
                managed: boolean;
              }>(
                `
            SELECT e.id,e.status,
            (EXISTS(SELECT 1 FROM scheduled_task_runs r WHERE r.execution_id=e.id AND r.outcome IS NULL)
             OR EXISTS(SELECT 1 FROM idle_attempts a
               JOIN workflow_versions v ON v.id=a.workflow_version_id
               WHERE a.execution_id=e.id AND a.state IN ('accepted','reserved')
                 AND e.trigger_event->>'schemaVersion'='chat-idle-v1' AND e.recovery_attempt<3
                 AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.definition->'nodes') n
                   WHERE n->>'type'='message-trigger' AND n->'config'->'idle'->>'enabled'='true')
                 AND NOT EXISTS(SELECT 1 FROM outbound_deliveries d WHERE d.execution_id=e.id))) AS managed
            FROM workflow_executions e WHERE e.status IN ('created','running','retrying')
              AND e.created_at<=$1::timestamptz AND ($2::uuid IS NULL OR e.id>$2::uuid)
            ORDER BY e.id LIMIT $3 FOR UPDATE OF e`,
                [boundary, cursor, batchSize],
              )
            ).rows;
          if (!rows.length) {
            await this.client.query("COMMIT");
            break;
          }
          const closing = rows.filter((r) => !r.managed);
          const ids = closing.map((r) => r.id);
          let nodes = 0,
            unknown = 0;
          if (ids.length) {
            // A submitted request cannot be assumed unsent. Never erase or retry it.
            await this.client.query(
              `UPDATE outbound_deliveries SET status='unknown',retryable=false,
              error_code=COALESCE(error_code,$2),error_summary=COALESCE(error_summary,$3),updated_at=now()
              WHERE execution_id=ANY($1::uuid[]) AND status='sending' AND closed_at IS NULL`,
              [ids, interrupted, "进程中断，发送结果待核实；禁止自动重发。"],
            );
            unknown = Number(
              (
                await this.client.query<{ count: string }>(
                  "SELECT count(*) FROM outbound_deliveries WHERE execution_id=ANY($1::uuid[]) AND status='unknown' AND closed_at IS NULL",
                  [ids],
                )
              ).rows[0]!.count,
            );
            nodes =
              (
                await this.client.query(
                  `UPDATE node_executions SET status='failed',completed_at=now(),retryable=false,
              error_code=COALESCE(error_code,$2),error_summary=COALESCE(error_summary,$3),
              duration_ms=LEAST(2147483647,GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(now()-started_at))*1000)))::integer
              WHERE execution_id=ANY($1::uuid[]) AND status='running'`,
                  [ids, interrupted, reason],
                )
              ).rowCount ?? 0;
            await this.client.query(
              `INSERT INTO audit_events(id,actor_type,action,target_type,target_id,outcome,correlation_id,metadata)
              SELECT gen_random_uuid(),'system','execution.startup-close','workflow-execution',id::text,'succeeded',$2::uuid,
              jsonb_build_object('previousStatus',status,'reasonCode',$3::text,'boundary',$4::text)
              FROM workflow_executions WHERE id=ANY($1::uuid[])`,
              [ids, report.runId, interrupted, boundary],
            );
            await this.client.query(
              `UPDATE workflow_executions SET startup_closure=jsonb_build_object(
              'runId',$2::text,'reasonCode',$3::text,'reason',$4::text,'previousStatus',status,'closedAt',now()),
              status='closed',current_node_id=NULL,next_retry_at=NULL,completed_at=COALESCE(completed_at,now())
              WHERE id=ANY($1::uuid[]) AND status IN ('created','running','retrying')`,
              [ids, report.runId, interrupted, reason],
            );
            await this.client.query(
              `UPDATE idle_attempts a SET state=CASE
              WHEN EXISTS(SELECT 1 FROM outbound_deliveries d WHERE d.execution_id=a.execution_id AND d.status IN ('sending','unknown')) THEN 'unknown'
              WHEN EXISTS(SELECT 1 FROM outbound_deliveries d WHERE d.execution_id=a.execution_id AND d.status='confirmed') THEN 'confirmed'
              ELSE 'released' END,updated_at=now()
              WHERE a.execution_id=ANY($1::uuid[]) AND a.state IN ('accepted','reserved')`,
              [ids],
            );
          }
          await this.client.query("COMMIT");
          report.scanned += rows.length;
          report.closed += ids.length;
          report.deferred += rows.length - ids.length;
          report.interruptedNodes += nodes;
          report.unknownDeliveries += unknown;
          cursor = rows.at(-1)!.id;
        } catch (error) {
          await this.client.query("ROLLBACK");
          throw error;
        }
      }
      await this.client.query(
        `INSERT INTO audit_events(id,actor_type,action,target_type,outcome,correlation_id,metadata)
        VALUES(gen_random_uuid(),'system','execution.startup-scan','workflow-runtime','succeeded',$1,$2::jsonb)`,
        [report.runId, JSON.stringify(report)],
      );
      this.heartbeat = setInterval(() => {
        void this.ping();
      }, 5000);
      this.heartbeat.unref();
      return report;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private async ping() {
    if (this.probing || this.stopping || !this.healthy) return;
    this.probing = true;
    try {
      await this.client!.query("SELECT 1");
    } catch {
      this.lost();
    } finally {
      this.probing = false;
    }
  }
  async close() {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.heartbeat);
    this.healthy = false;
    this.client?.release(true); // destroying this dedicated connection releases its advisory lock
    await this.pool.end();
  }
}
