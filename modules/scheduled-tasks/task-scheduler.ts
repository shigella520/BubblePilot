import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { WorkflowEngine } from "../workflow/workflow-engine.js";
import type { ScheduledTaskEvent } from "../workflow/workflow-event.js";
import { DEFAULT_CONTEXT_SETTINGS } from "../workflow/context-settings-types.js";
import { type TaskService, taskConfig, type TaskRow } from "./task-service.js";

interface Run {
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
    if ((await this.service.settings()).paused) return;
    await this.reconcile();
    const tasks = (
      await this.service.pool
        .query<TaskRow>(`SELECT t.* FROM scheduled_tasks t WHERE
   (t.status='pending' AND t.scheduled_at<=now()) OR (t.status='running' AND EXISTS(SELECT 1 FROM scheduled_task_runs r WHERE r.task_id=t.id AND r.outcome IS NULL AND r.lease_expires_at<now())) ORDER BY t.scheduled_at,t.id LIMIT 20`)
    ).rows;
    for (const task of tasks) {
      try {
        await this.dispatch(task);
      } catch {
        this.reportError();
      }
    }
  }
  private async dispatch(task: TaskRow) {
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
    const event: ScheduledTaskEvent = {
      schemaVersion: "scheduled-task-v1",
      eventId: `scheduled:${task.id}:${task.version}`,
      correlationId: randomUUID(),
      provider: "bluebubbles",
      chat: {
        providerChatId: chat.provider_chat_id,
        type: chat.type,
        displayName: chat.display_name,
      },
      message: null,
      scheduled: {
        taskId: task.id,
        taskVersion: task.version,
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
              current.version !== task.version ||
              !["pending", "running"].includes(current.status)
            )
              return undefined;
            if (current.expires_at <= current.now) {
              await this.endLocked(db, current, "expired", "task-expired");
              return undefined;
            }
            const existing = (
              await db.query<Run>(
                "SELECT * FROM scheduled_task_runs WHERE task_id=$1 AND task_version=$2 FOR UPDATE",
                [task.id, task.version],
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
              `INSERT INTO scheduled_task_runs(id,task_id,task_version,execution_id,workflow_version_id,task_snapshot,history_boundary,lease_owner,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,now()+interval '60 seconds')`,
              [
                randomUUID(),
                task.id,
                task.version,
                id,
                binding.workflowVersionId,
                JSON.stringify(event.scheduled),
                boundary,
                this.owner,
              ],
            );
            await db.query(
              "UPDATE scheduled_tasks SET status='running',updated_at=now() WHERE id=$1",
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
        `SELECT t.*,r.workflow_version_id FROM scheduled_task_runs r JOIN scheduled_tasks t ON t.id=r.task_id JOIN chats c ON c.id=t.chat_id JOIN workflow_executions e ON e.id=r.execution_id WHERE e.status IN ('created','running','retrying') AND r.execution_id=$1 AND r.lease_owner=$2 AND r.lease_generation=$3 AND r.lease_expires_at>now() AND r.outcome IS NULL AND t.version=r.task_version AND t.status='running' AND t.expires_at>now() AND c.enabled AND c.deleted_at IS NULL AND NOT (SELECT paused FROM scheduled_task_settings WHERE id=1)`,
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
        `UPDATE scheduled_task_runs SET phase='sending' WHERE execution_id=$1 AND task_version=$2 AND lease_owner=$3 AND lease_generation=$4 AND lease_expires_at>now() AND outcome IS NULL AND EXISTS(SELECT 1 FROM scheduled_tasks t JOIN chats c ON c.id=t.chat_id JOIN workflows w ON w.id=t.workflow_id JOIN bot_triggers b ON b.workflow_version_id=w.published_version_id WHERE t.id=scheduled_task_runs.task_id AND t.expires_at>now() AND c.enabled AND c.deleted_at IS NULL AND w.status='active' AND w.deleted_at IS NULL AND b.enabled AND b.deleted_at IS NULL AND b.workflow_version_id=scheduled_task_runs.workflow_version_id) RETURNING id`,
        [executionId, task.version, this.owner, generation],
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
  ) {
    await db.query(
      "UPDATE scheduled_tasks SET status=$2,finished_at=now(),updated_at=now() WHERE id=$1",
      [task.id, status],
    );
    await db.query(
      "UPDATE scheduled_task_runs SET outcome=$2,reason_code=$3,phase='finished',finished_at=now() WHERE task_id=$1 AND outcome IS NULL",
      [task.id, status, reason],
    );
    await db.query(
      `INSERT INTO scheduled_task_events(id,task_id,event_type,actor_type,to_version,reason_code) VALUES($1,$2,$3,'system',$4,$5)`,
      [randomUUID(), task.id, status, task.version, reason],
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
      if (task && task.status === "pending")
        await this.endLocked(db, task, status, reason);
    });
  }
  async reconcile() {
    const rows = (
      await this.service.pool.query<{
        task_id: string;
        execution_id: string;
        status: string;
        error_code: string | null;
      }>(
        `SELECT r.task_id,r.execution_id,e.status,e.error_code FROM scheduled_task_runs r JOIN workflow_executions e ON e.id=r.execution_id WHERE r.outcome IS NULL AND e.status NOT IN ('created','running','retrying')`,
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
        if (!task || task.status !== "running") return;
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
        );
      });
    await this.service.pool.query(
      `UPDATE workflow_executions e SET trigger_event=jsonb_set(jsonb_set(e.trigger_event,'{scheduled,content}','""'::jsonb),'{scheduled,requestSnapshot}','""'::jsonb) FROM scheduled_task_runs r JOIN scheduled_tasks t ON t.id=r.task_id WHERE r.execution_id=e.id AND t.finished_at<now()-interval '90 days' AND e.trigger_event->>'schemaVersion'='scheduled-task-v1' AND (e.trigger_event->'scheduled'->>'content'<>'' OR e.trigger_event->'scheduled'->>'requestSnapshot'<>'')`,
    );
    await this.service.pool.query(
      `UPDATE scheduled_tasks SET request_snapshot=NULL,content=NULL WHERE finished_at<now()-interval '90 days' AND (request_snapshot IS NOT NULL OR content IS NOT NULL)`,
    );
    await this.service.pool.query(
      `UPDATE scheduled_task_events SET change_data=NULL WHERE change_data IS NOT NULL AND task_id IN(SELECT id FROM scheduled_tasks WHERE finished_at<now()-interval '90 days')`,
    );
    await this.service.pool.query(
      `UPDATE scheduled_task_runs SET task_snapshot=NULL WHERE task_snapshot IS NOT NULL AND task_id IN(SELECT id FROM scheduled_tasks WHERE finished_at<now()-interval '90 days')`,
    );
  }
}
