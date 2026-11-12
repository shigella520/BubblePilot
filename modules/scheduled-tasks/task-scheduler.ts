import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { WorkflowEngine } from "../workflow/workflow-engine.js";
import type { ScheduledTaskEvent } from "../workflow/workflow-event.js";
import { DEFAULT_CONTEXT_SETTINGS } from "../workflow/context-settings-types.js";
import { type TaskService, taskConfig, type TaskRow } from "./task-service.js";

import { nextScheduledTime } from "./task-schedule.js";

interface Run {
  occurrence_id: string;
  id: string;
  task_id: string;
  task_version: number;
  execution_id: string;
  workflow_version_id: string;
  phase: string;
  lease_owner: string;
  lease_generation: number;
  lease_expires_at: Date;
  outcome: string | null;
}
export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private nextCleanupAt = 0;
  private readonly owner = randomUUID();
  constructor(
    readonly service: TaskService,
    readonly engine: WorkflowEngine,
    private readonly reportError: () => void = () => undefined,
  ) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.schedule(), 10000);
    this.timer.unref();
    this.schedule();
  }
  private schedule() {
    if (this.running) return;
    this.running = this.tick()
      .catch(() => this.reportError())
      .finally(() => {
        this.running = undefined;
      });
  }
  async close() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
  async tick() {
    // Retention is independent of the reminder pause switch and bounded per batch.
    if (Date.now() >= this.nextCleanupAt) {
      this.nextCleanupAt = Date.now() + 60_000;
      try {
        await this.service.purgeExpired();
      } catch {
        this.reportError();
      }
    }
    if ((await this.service.settings()).paused) return;
    await this.reconcile();
    const tasks = (
      await this.service.pool
        .query<TaskRow>(`SELECT t.* FROM scheduled_tasks t WHERE
   (t.lifecycle='active' AND t.status='pending' AND t.scheduled_at<=now()) OR (EXISTS(SELECT 1 FROM scheduled_task_runs r WHERE r.task_id=t.id AND r.outcome IS NULL AND r.lease_expires_at<now())) ORDER BY t.scheduled_at,t.id LIMIT 20`)
    ).rows;
    for (const task of tasks) {
      try {
        const prepared = await this.prepare(task.id);
        if (prepared) await this.dispatch(prepared);
      } catch {
        this.reportError();
      }
    }
  }
  private async prepare(
    id: string,
  ): Promise<
    (TaskRow & { occurrenceId: string; occurrenceNumber: string }) | null
  > {
    return this.service.transaction(async (db) => {
      let t = (
        await db.query<TaskRow & { now: Date }>(
          "SELECT *,now() AS now FROM scheduled_tasks WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!t) return null;
      const running = (
        await db.query<Run>(
          "SELECT * FROM scheduled_task_runs WHERE task_id=$1 AND outcome IS NULL",
          [id],
        )
      ).rows[0];
      if (running) {
        if (running.lease_expires_at > t.now) return null;
        const deliveries = (
          await db.query<{ status: string }>(
            "SELECT status FROM outbound_deliveries WHERE execution_id=$1",
            [running.execution_id],
          )
        ).rows;
        if (deliveries.length || t.lifecycle !== "active" || t.resume_after) {
          const result = deliveries.length
            ? deliveries.every((d) => d.status === "confirmed")
              ? "sent"
              : deliveries.some((d) =>
                    ["pending", "sending", "unknown"].includes(d.status),
                  )
                ? "delivery_unknown"
                : "failed"
            : "cancelled";
          await this.endLocked(
            db,
            t,
            result,
            "task-recovered-delivery",
            running.occurrence_id,
          );
          await db.query(
            "UPDATE workflow_executions SET status=$2,completed_at=now(),error_code=$3 WHERE id=$1 AND status IN ('created','running','retrying')",
            [
              running.execution_id,
              result === "sent" ? "succeeded" : "failed",
              result === "sent" ? null : "TASK_RECOVERED_DELIVERY",
            ],
          );
          return null;
        }
        const o = (
          await db.query<{ occurrence_number: string }>(
            "SELECT occurrence_number FROM scheduled_task_occurrences WHERE id=$1",
            [running.occurrence_id],
          )
        ).rows[0]!;
        return {
          ...t,
          occurrenceId: running.occurrence_id,
          occurrenceNumber: o.occurrence_number,
        };
      }
      if (t.lifecycle !== "active") return null;
      const settings = (
        await db.query<{ catchup_minutes: number }>(
          "SELECT catchup_minutes FROM scheduled_task_settings WHERE id=1",
        )
      ).rows[0]!;
      if (t.resume_after) {
        const next = nextScheduledTime(
          t.schedule,
          t.timezone,
          t.resume_after,
          t.schedule.kind === "once" ? 0 : t.consumed_count,
        );
        await db.query(
          "UPDATE scheduled_task_occurrences SET status='cancelled',reason_code='global-pause',finished_at=now() WHERE task_id=$1 AND status='pending'",
          [id],
        );
        if (!next) {
          await db.query(
            "UPDATE scheduled_tasks SET lifecycle='completed',status='expired',finished_at=now(),resume_after=NULL WHERE id=$1",
            [id],
          );
          return null;
        }
        t = (
          await db.query<TaskRow & { now: Date }>(
            "UPDATE scheduled_tasks SET scheduled_at=$2,expires_at=$3,resume_after=NULL,status='pending' WHERE id=$1 RETURNING *,now() AS now",
            [
              id,
              next,
              new Date(
                next.getTime() + Math.max(1, settings.catchup_minutes) * 60000,
              ),
            ],
          )
        ).rows[0]!;
      }
      if (t.status !== "pending" || t.scheduled_at > t.now) return null;
      if (t.schedule.kind === "recurring") {
        // Compress missed slots into one event. Bounded batches also bound lock time
        // after exceptionally long outages; never send an old slot from a batch.
        const first = t.scheduled_at;
        let at: Date | null = first;
        let missed = 0;
        while (at && missed < 512) {
          const next = nextScheduledTime(
            t.schedule,
            t.timezone,
            at,
            t.consumed_count + missed + 1,
          );
          if (
            (!next || next > t.now) &&
            at.getTime() + Math.max(1, settings.catchup_minutes) * 60000 >
              t.now.getTime()
          )
            break;
          if (at > t.now) break;
          missed++;
          at = next;
        }
        if (missed) {
          await db.query(
            "UPDATE scheduled_task_occurrences SET status='expired',consumed=true,reason_code='missed-window',finished_at=now() WHERE task_id=$1 AND status='pending'",
            [id],
          );
          await db.query(
            `INSERT INTO scheduled_task_events(id,task_id,event_type,actor_type,to_version,change_data) VALUES($1,$2,'missed-occurrences','system',$3,$4::jsonb)`,
            [
              randomUUID(),
              id,
              t.version,
              JSON.stringify({
                from: first.toISOString(),
                before: at?.toISOString() ?? null,
                count: missed,
              }),
            ],
          );
          t = (
            await db.query<TaskRow & { now: Date }>(
              `UPDATE scheduled_tasks SET consumed_count=consumed_count+$2,scheduled_at=COALESCE($3,scheduled_at),expires_at=COALESCE($4,expires_at),lifecycle=CASE WHEN $3::timestamptz IS NULL THEN 'completed' ELSE lifecycle END,status=CASE WHEN $3::timestamptz IS NULL THEN 'completed' ELSE 'pending' END,finished_at=CASE WHEN $3::timestamptz IS NULL THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING *,now() AS now`,
              [
                id,
                missed,
                at,
                at
                  ? new Date(
                      at.getTime() +
                        Math.max(1, settings.catchup_minutes) * 60000,
                    )
                  : null,
              ],
            )
          ).rows[0]!;
          if (!at || at > t.now || missed === 512) return null;
        }
      }
      const o = await this.service.ensureOccurrence(db, t);
      return {
        ...t,
        occurrenceId: o.id,
        occurrenceNumber: o.occurrence_number,
      };
    });
  }
  private async dispatch(
    task: TaskRow & { occurrenceId: string; occurrenceNumber: string },
  ) {
    const chat = (
      await this.service.pool.query<{
        provider_chat_id: string;
        type: "direct" | "group" | "unknown";
        display_name: string | null;
        next_message_index: string;
      }>("SELECT * FROM chats WHERE id=$1 AND enabled AND deleted_at IS NULL", [
        task.chat_id,
      ])
    ).rows[0];
    let binding;
    try {
      binding = chat
        ? await this.service.binding(task.workflow_id, chat.provider_chat_id)
        : null;
    } catch {
      binding = null;
    }
    if (!binding || !chat) {
      await this.terminate(
        task.id,
        "cancelled",
        "task-configuration-unavailable",
      );
      return;
    }
    let event: ScheduledTaskEvent = {
      schemaVersion: "scheduled-task-v2",
      eventId: `scheduled:${task.occurrenceId}`,
      correlationId: randomUUID(),
      provider: "bluebubbles",
      chat: {
        providerChatId: chat.provider_chat_id,
        type: chat.type,
        displayName: chat.display_name,
      },
      message: null,
      scheduled: {
        occurrenceId: task.occurrenceId,
        occurrenceNumber: task.occurrenceNumber,
        taskId: task.id,
        taskVersion: task.execution_version,
        chatId: task.chat_id,
        content: task.content ?? "",
        requestSnapshot: task.request_snapshot ?? "",
        creatorSenderId: task.creator_sender_id,
        scheduledAt: task.scheduled_at.toISOString(),
        triggeredAt: new Date().toISOString(),
        timeZone: task.timezone,
        upperMessageIndex: chat.next_message_index,
        workflowVersionId: binding.workflowVersionId,
      },
    };
    const recovering = (
      await this.service.pool.query<Run>(
        "SELECT * FROM scheduled_task_runs WHERE occurrence_id=$1 AND outcome IS NULL",
        [task.occurrenceId],
      )
    ).rows[0];
    if (recovering) {
      if (recovering.workflow_version_id !== binding.workflowVersionId) {
        await this.service.transaction(async (db) => {
          const locked = (
            await db.query<TaskRow>(
              "SELECT * FROM scheduled_tasks WHERE id=$1 FOR UPDATE",
              [task.id],
            )
          ).rows[0]!;
          await this.endLocked(
            db,
            locked,
            "cancelled",
            "task-workflow-changed",
            recovering.occurrence_id,
          );
        });
        return;
      }
      const previous = await this.service.workflows.getExecution(
        recovering.execution_id,
      );
      if (
        previous?.triggerEvent &&
        previous.triggerEvent.schemaVersion !== "chat-idle-v1"
      )
        event = previous.triggerEvent;
    }
    let generation = 0;
    let executionId: string | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      await this.engine.handleBackground({
        trigger: binding,
        event,
        accept: async () => {
          executionId = await this.service.transaction(async (db) => {
            const current = (
              await db.query<TaskRow & { now: Date }>(
                "SELECT *,now() AS now FROM scheduled_tasks WHERE id=$1 FOR UPDATE",
                [task.id],
              )
            ).rows[0];
            if (
              !current ||
              current.execution_version !== task.execution_version ||
              current.lifecycle !== "active" ||
              current.resume_after !== null ||
              !["pending", "running"].includes(current.status)
            )
              return undefined;
            if (
              (
                await db.query<{ paused: boolean }>(
                  "SELECT paused FROM scheduled_task_settings WHERE id=1",
                )
              ).rows[0]!.paused
            )
              return undefined;
            const instance = (
              await db.query<{ status: string }>(
                "SELECT status FROM scheduled_task_occurrences WHERE id=$1 AND task_version=$2",
                [task.occurrenceId, current.execution_version],
              )
            ).rows[0];
            if (!instance || !["pending", "running"].includes(instance.status))
              return undefined;
            if (current.expires_at <= current.now) {
              await this.endLocked(db, current, "expired", "task-expired");
              return undefined;
            }
            const existing = (
              await db.query<Run>(
                "SELECT * FROM scheduled_task_runs WHERE occurrence_id=$1 FOR UPDATE",
                [task.occurrenceId],
              )
            ).rows[0];
            if (existing) {
              if (existing.outcome || existing.lease_expires_at > current.now)
                return undefined;
              const deliveries = (
                await db.query<{ status: string }>(
                  "SELECT status FROM outbound_deliveries WHERE execution_id=$1",
                  [existing.execution_id],
                )
              ).rows;
              if (deliveries.length) {
                const outcome = deliveries.every(
                  (d) => d.status === "confirmed",
                )
                  ? "sent"
                  : deliveries.some((d) =>
                        ["sending", "unknown", "pending"].includes(d.status),
                      )
                    ? "delivery_unknown"
                    : "failed";
                await this.endLocked(
                  db,
                  current,
                  outcome,
                  "task-recovered-delivery",
                );
                return undefined;
              }
              const row = (
                await db.query<Run>(
                  `UPDATE scheduled_task_runs SET lease_owner=$2,lease_generation=lease_generation+1,lease_expires_at=now()+interval '60 seconds' WHERE id=$1 AND lease_expires_at<now() AND lease_generation<3 RETURNING *`,
                  [existing.id, this.owner],
                )
              ).rows[0];
              if (!row) {
                if (existing.lease_generation >= 3)
                  await this.endLocked(
                    db,
                    current,
                    "failed",
                    "task-recovery-limit",
                  );
                return undefined;
              }
              if (existing.workflow_version_id !== binding.workflowVersionId) {
                await this.endLocked(
                  db,
                  current,
                  "cancelled",
                  "task-workflow-changed",
                );
                return undefined;
              }
              generation = row.lease_generation;
              await db.query(
                "UPDATE node_executions SET status='failed',completed_at=now(),error_code='TASK_EXECUTION_INTERRUPTED',error_summary='任务执行中断后恢复' WHERE execution_id=$1 AND status='running'",
                [existing.execution_id],
              );
              return existing.execution_id;
            }
            const boundary = (
              await db.query<{ next_message_index: string }>(
                "SELECT next_message_index FROM chats WHERE id=$1",
                [task.chat_id],
              )
            ).rows[0]!.next_message_index;
            event.scheduled.upperMessageIndex = boundary;
            event.scheduled.triggeredAt = current.now.toISOString();
            const snapshot = (
              await db.query<{ snapshot: unknown }>(
                `SELECT COALESCE((SELECT snapshot FROM conversation_context_windows WHERE chat_id=$1 AND trigger_message_index<$2 ORDER BY trigger_message_index DESC LIMIT 1),jsonb_build_object('contract','raw-context-v1','afterMessageIndex',(SELECT COALESCE(min(message_index)-1,0)::text FROM (SELECT message_index FROM messages WHERE chat_id=$1 AND message_index<$2 AND (s.include_from_me OR NOT is_from_me) AND content_redacted_at IS NULL ORDER BY message_index DESC LIMIT s.base_message_window) m),'settings',jsonb_build_object('includeFromMe',s.include_from_me,'baseMessageWindow',s.base_message_window,'redundancyMessageWindow',s.redundancy_message_window,'characterLimit',s.character_limit),'settingsVersion',s.version,'compatibilityInitialized',true)) || jsonb_build_object('chatId',$1::text,'triggerMessageIndex',$2::text) AS snapshot FROM (SELECT include_from_me,base_message_window,redundancy_message_window,character_limit,version FROM conversation_context_settings WHERE id=1 UNION ALL SELECT $3::boolean,$4::int,$5::int,$6::int,0 WHERE NOT EXISTS(SELECT 1 FROM conversation_context_settings WHERE id=1)) s`,
                [
                  task.chat_id,
                  boundary,
                  DEFAULT_CONTEXT_SETTINGS.includeFromMe,
                  DEFAULT_CONTEXT_SETTINGS.baseMessageWindow,
                  DEFAULT_CONTEXT_SETTINGS.redundancyMessageWindow,
                  DEFAULT_CONTEXT_SETTINGS.characterLimit,
                ],
              )
            ).rows[0]!.snapshot;
            const id = randomUUID();
            await db.query(
              `INSERT INTO workflow_executions(id,provider,external_event_id,trigger_id,workflow_version_id,correlation_id,status,target_chat_id,trigger_event,trigger_message_index,context_snapshot) VALUES($1,'bluebubbles',$2,$3,$4,$5,'created',$6,$7::jsonb,$8,$9::jsonb)`,
              [
                id,
                event.eventId,
                binding.id,
                binding.workflowVersionId,
                event.correlationId,
                task.chat_id,
                JSON.stringify(event),
                boundary,
                JSON.stringify(snapshot),
              ],
            );
            await db.query(
              `INSERT INTO scheduled_task_runs(id,task_id,task_version,execution_id,workflow_version_id,task_snapshot,history_boundary,lease_owner,lease_expires_at,occurrence_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,now()+interval '60 seconds',$9)`,
              [
                randomUUID(),
                task.id,
                task.execution_version,
                id,
                binding.workflowVersionId,
                JSON.stringify(event.scheduled),
                boundary,
                this.owner,
                task.occurrenceId,
              ],
            );
            await db.query(
              "UPDATE scheduled_task_occurrences SET status='running',consumed=true,scheduled_at=$2,expires_at=$3 WHERE id=$1",
              [task.occurrenceId, current.scheduled_at, current.expires_at],
            );
            await db.query(
              "UPDATE scheduled_tasks SET status='running',consumed_count=consumed_count+1,updated_at=now() WHERE id=$1",
              [task.id],
            );
            await db.query(
              `INSERT INTO scheduled_task_events(id,task_id,event_type,actor_type,to_version,source_execution_id) VALUES($1,$2,'accepted','system',$3,$4)`,
              [randomUUID(), task.id, task.version, id],
            );
            generation = 1;
            return id;
          });
          if (!executionId) return null;
          heartbeat = setInterval(() => {
            void this.service.pool
              .query(
                "UPDATE scheduled_task_runs SET lease_expires_at=now()+interval '60 seconds' WHERE execution_id=$1 AND lease_owner=$2 AND lease_generation=$3 AND outcome IS NULL",
                [executionId, this.owner, generation],
              )
              .catch(() => this.reportError());
          }, 15000);
          heartbeat.unref();
          return this.service.workflows.getExecution(executionId);
        },
        guard: (id) => this.guard(id, generation),
        afterSend: async (id, knownFailed) => {
          if (knownFailed)
            await this.service.pool.query(
              "UPDATE scheduled_task_runs SET phase='ready' WHERE execution_id=$1 AND lease_owner=$2 AND lease_generation=$3 AND outcome IS NULL",
              [id, this.owner, generation],
            );
        },
        commitSend: (id, deliveryId) =>
          this.commitSend(id, deliveryId, generation),
      });
    } finally {
      clearInterval(heartbeat);
    }
    await this.reconcile();
  }
  async guard(executionId: string, generation: number): Promise<string | null> {
    const row = (
      await this.service.pool.query<TaskRow & { workflow_version_id: string }>(
        `SELECT t.*,r.workflow_version_id FROM scheduled_task_runs r JOIN scheduled_tasks t ON t.id=r.task_id JOIN chats c ON c.id=t.chat_id JOIN workflow_executions e ON e.id=r.execution_id WHERE e.status IN ('created','running','retrying') AND r.execution_id=$1 AND r.lease_owner=$2 AND r.lease_generation=$3 AND r.lease_expires_at>now() AND r.outcome IS NULL AND t.execution_version=r.task_version AND t.status='running' AND t.resume_after IS NULL AND t.expires_at>now() AND c.enabled AND c.deleted_at IS NULL AND NOT (SELECT paused FROM scheduled_task_settings WHERE id=1)`,
        [executionId, this.owner, generation],
      )
    ).rows[0];
    if (!row) return "task-no-longer-eligible";
    const binding = (
      await this.service.workflows.listActiveTriggerBindings()
    ).find(
      (t) =>
        t.workflowId === row.workflow_id &&
        t.workflowVersionId === row.workflow_version_id,
    );
    const chat = (
      await this.service.pool.query<{ provider_chat_id: string }>(
        "SELECT provider_chat_id FROM chats WHERE id=$1",
        [row.chat_id],
      )
    ).rows[0];
    if (
      !binding ||
      !taskConfig(binding)?.enabled ||
      !chat ||
      !taskConfig(binding)?.chatIds.includes(chat.provider_chat_id)
    )
      return "task-configuration-changed";
    return null;
  }
  private async commitSend(
    executionId: string,
    deliveryId: string,
    generation: number,
  ): Promise<string | null> {
    const reason = await this.guard(executionId, generation);
    if (reason) return reason;
    return this.service.transaction(async (db) => {
      // Cancellation and the irreversible-send fence contend on the same task row.
      const task = (
        await db.query<TaskRow>(
          "SELECT t.* FROM scheduled_tasks t JOIN scheduled_task_runs r ON r.task_id=t.id WHERE r.execution_id=$1 FOR UPDATE OF t",
          [executionId],
        )
      ).rows[0];
      if (!task || task.status !== "running") return "task-cancelled";
      const claimed = await db.query(
        `UPDATE scheduled_task_runs SET phase='sending' WHERE execution_id=$1 AND task_version=$2 AND lease_owner=$3 AND lease_generation=$4 AND lease_expires_at>now() AND outcome IS NULL AND EXISTS(SELECT 1 FROM scheduled_tasks t JOIN chats c ON c.id=t.chat_id JOIN workflows w ON w.id=t.workflow_id JOIN bot_triggers b ON b.workflow_version_id=w.published_version_id WHERE t.id=scheduled_task_runs.task_id AND t.resume_after IS NULL AND NOT (SELECT paused FROM scheduled_task_settings WHERE id=1) AND t.expires_at>now() AND c.enabled AND c.deleted_at IS NULL AND w.status='active' AND w.deleted_at IS NULL AND b.enabled AND b.deleted_at IS NULL AND b.workflow_version_id=scheduled_task_runs.workflow_version_id) RETURNING id`,
        [executionId, task.execution_version, this.owner, generation],
      );
      if (!claimed.rowCount) return "task-no-longer-eligible";
      const delivery = await db.query(
        "UPDATE outbound_deliveries SET status='sending',attempt_count=attempt_count+1,error_code=NULL,error_summary=NULL,retryable=NULL,updated_at=now() WHERE id=$1 AND execution_id=$2 AND status IN ('pending','failed') AND closed_at IS NULL AND EXISTS(SELECT 1 FROM workflow_executions e WHERE e.id=$2 AND e.status='running') RETURNING id",
        [deliveryId, executionId],
      );
      if (!delivery.rowCount)
        throw new Error("Task delivery no longer eligible");
      return null;
    });
  }
  private async endLocked(
    db: PoolClient,
    task: TaskRow,
    status: string,
    reason: string,
    occurrenceId?: string,
  ) {
    const o = (
      await db.query<{ id: string; consumed: boolean; scheduled_at: Date }>(
        "SELECT * FROM scheduled_task_occurrences WHERE task_id=$1 AND status IN ('pending','running') AND ($2::uuid IS NULL OR id=$2) FOR UPDATE",
        [task.id, occurrenceId ?? null],
      )
    ).rows[0];
    if (!o) return;
    await db.query(
      "UPDATE scheduled_task_occurrences SET status=$2,consumed=true,reason_code=$3,finished_at=now() WHERE id=$1",
      [o.id, status, reason],
    );
    await db.query(
      "UPDATE scheduled_task_runs SET outcome=$2,reason_code=$3,phase='finished',finished_at=now() WHERE occurrence_id=$1 AND outcome IS NULL",
      [o.id, status, reason],
    );
    await db.query(
      "UPDATE workflow_executions e SET status=$2,completed_at=now(),error_code=$3 FROM scheduled_task_runs r WHERE r.execution_id=e.id AND r.occurrence_id=$1 AND e.status IN ('created','running','retrying')",
      [
        o.id,
        status === "sent"
          ? "succeeded"
          : ["cancelled", "expired"].includes(status)
            ? "skipped"
            : "failed",
        status === "sent" ? null : "TASK_EXECUTION_FINISHED",
      ],
    );
    const consumed = task.consumed_count + (o.consumed ? 0 : 1);
    const next =
      task.lifecycle === "active" && task.schedule.kind === "recurring"
        ? nextScheduledTime(
            task.schedule,
            task.timezone,
            task.resume_after && task.resume_after > o.scheduled_at
              ? task.resume_after
              : o.scheduled_at,
            consumed,
          )
        : null;
    const settings = (
      await db.query<{ catchup_minutes: number }>(
        "SELECT catchup_minutes FROM scheduled_task_settings WHERE id=1",
      )
    ).rows[0]!;
    const lifecycle =
      task.lifecycle === "active"
        ? next
          ? "active"
          : "completed"
        : task.lifecycle;
    await db.query(
      `UPDATE scheduled_tasks SET consumed_count=$2,lifecycle=$3,status=$4,scheduled_at=COALESCE($5,scheduled_at),expires_at=COALESCE($6,expires_at),finished_at=CASE WHEN $3 IN ('completed','cancelled') THEN now() ELSE NULL END,resume_after=NULL,updated_at=now() WHERE id=$1`,
      [
        task.id,
        consumed,
        lifecycle,
        next
          ? "pending"
          : task.lifecycle !== "active"
            ? task.lifecycle
            : task.schedule.kind === "once"
              ? status
              : "completed",
        next,
        next
          ? new Date(
              next.getTime() + Math.max(1, settings.catchup_minutes) * 60000,
            )
          : null,
      ],
    );
    await db.query(
      `INSERT INTO scheduled_task_events(id,task_id,event_type,actor_type,to_version,reason_code,change_data) VALUES($1,$2,$3,'system',$4,$5,$6::jsonb)`,
      [
        randomUUID(),
        task.id,
        status,
        task.version,
        reason,
        JSON.stringify({ occurrenceId: o.id }),
      ],
    );
  }
  private async terminate(id: string, status: string, reason: string) {
    await this.service.transaction(async (db) => {
      const task = (
        await db.query<TaskRow>(
          "SELECT * FROM scheduled_tasks WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (task) {
        await db.query(
          "UPDATE scheduled_tasks SET lifecycle='cancelled' WHERE id=$1",
          [id],
        );
        task.lifecycle = "cancelled";
        await this.endLocked(db, task, status, reason);
      }
    });
  }
  async reconcile() {
    const { retention_days: retentionDays } = await this.service.settings();
    await this.service.pool.query(
      "UPDATE scheduled_task_occurrences SET snapshot=NULL WHERE finished_at<now()-($1::int * interval '1 day') AND snapshot IS NOT NULL",
      [retentionDays],
    );
    await this.service.pool.query(
      "DELETE FROM scheduled_task_operations WHERE created_at<now()-interval '90 days'",
    );
    const rows = (
      await this.service.pool.query<{
        task_id: string;
        occurrence_id: string;
        execution_id: string;
        status: string;
        error_code: string | null;
      }>(
        `SELECT r.task_id,r.occurrence_id,r.execution_id,e.status,e.error_code FROM scheduled_task_runs r JOIN workflow_executions e ON e.id=r.execution_id WHERE r.outcome IS NULL AND e.status NOT IN ('created','running','retrying')`,
      )
    ).rows;
    for (const row of rows)
      await this.service.transaction(async (db) => {
        const task = (
          await db.query<TaskRow>(
            "SELECT * FROM scheduled_tasks WHERE id=$1 FOR UPDATE",
            [row.task_id],
          )
        ).rows[0];
        if (!task) return;
        const deliveries = (
          await db.query<{ status: string }>(
            "SELECT status FROM outbound_deliveries WHERE execution_id=$1",
            [row.execution_id],
          )
        ).rows;
        const outcome = deliveries.some((d) => d.status === "confirmed")
          ? "sent"
          : deliveries.some((d) =>
                ["pending", "sending", "unknown"].includes(d.status),
              )
            ? "delivery_unknown"
            : row.status === "skipped"
              ? task.expires_at <= new Date()
                ? "expired"
                : "cancelled"
              : "failed";
        await this.endLocked(
          db,
          task,
          outcome,
          row.error_code ?? `execution-${row.status}`,
          row.occurrence_id,
        );
      });
    await this.service.pool.query(
      `UPDATE workflow_executions e SET trigger_event=jsonb_set(jsonb_set(e.trigger_event,'{scheduled,content}','""'::jsonb),'{scheduled,requestSnapshot}','""'::jsonb) FROM scheduled_task_runs r JOIN scheduled_tasks t ON t.id=r.task_id WHERE r.execution_id=e.id AND r.finished_at<now()-($1::int * interval '1 day') AND e.trigger_event->>'schemaVersion' IN ('scheduled-task-v1','scheduled-task-v2') AND (e.trigger_event->'scheduled'->>'content'<>'' OR e.trigger_event->'scheduled'->>'requestSnapshot'<>'')`,
      [retentionDays],
    );
    await this.service.pool.query(
      `UPDATE scheduled_tasks SET request_snapshot=NULL,content=NULL,summary=NULL WHERE finished_at<now()-($1::int * interval '1 day') AND (request_snapshot IS NOT NULL OR content IS NOT NULL OR summary IS NOT NULL)`,
      [retentionDays],
    );
    await this.service.pool.query(
      `UPDATE scheduled_task_events SET change_data=NULL WHERE change_data IS NOT NULL AND created_at<now()-($1::int * interval '1 day')`,
      [retentionDays],
    );
    await this.service.pool.query(
      `UPDATE scheduled_task_runs SET task_snapshot=NULL WHERE task_snapshot IS NOT NULL AND finished_at<now()-($1::int * interval '1 day')`,
      [retentionDays],
    );
  }
}
