import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { RegisteredAgentTool } from "../ai/agent-tool-registry.js";
import type { AgentToolContext } from "../ai/agent-budget.js";
import type {
  WorkflowRepository,
  TriggerBinding,
} from "../workflow/workflow-repository.js";
import {
  cancelTaskSchema,
  createTaskSchema,
  listTasksSchema,
  updateTaskSchema,
  TaskError,
  validateSchedule,
} from "./task-policy.js";

import {
  nextScheduledTime,
  schedulePreview,
  scheduleSummary,
  type TaskSchedule,
} from "./task-schedule.js";

export interface TaskRow {
  schedule: TaskSchedule;
  lifecycle: "active" | "paused" | "completed" | "cancelled";
  consumed_count: number;
  occurrence_sequence: string;
  resume_after: Date | null;
  sendingAlreadyStarted?: boolean;
  id: string;
  chat_id: string;
  workflow_id: string;
  creator_sender_id: string;
  source_message_id: string | null;
  source_execution_id: string | null;
  request_snapshot: string | null;
  summary: string | null;
  execution_version: number;
  content: string | null;
  scheduled_at: Date;
  timezone: string;
  expires_at: Date;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}
export interface TaskActor {
  kind: "member" | "admin";
  id: string;
  executionId?: string;
  chatId?: string;
  workflowId?: string;
}
export function taskConfig(trigger: TriggerBinding) {
  const node = trigger.definition.nodes.find(
    (n) => n.type === "message-trigger",
  );
  return node?.type === "message-trigger" ? node.config.scheduled : undefined;
}
export function publicTask(t: TaskRow) {
  return {
    id: t.id,
    summary: t.summary ?? null,
    content: t.content,
    scheduledAt: t.scheduled_at.toISOString(),
    timeZone: t.timezone,
    status: t.status,
    version: t.version,
    sendingAlreadyStarted: t.sendingAlreadyStarted ?? false,
    schedule: t.schedule,
    lifecycle: t.lifecycle,
    consumedCount: t.consumed_count,
    nextScheduledAt:
      t.lifecycle === "active" ? t.scheduled_at.toISOString() : null,
    scheduleSummary: scheduleSummary(t.schedule),
    upcoming:
      t.lifecycle === "active"
        ? schedulePreview(
            t.schedule,
            t.timezone,
            new Date(t.scheduled_at.getTime() - 1),
            t.schedule.kind === "once"
              ? 0
              : t.consumed_count - (t.status === "running" ? 1 : 0),
          )
        : [],
  };
}
export class TaskService {
  constructor(
    readonly pool: Pool,
    readonly workflows: WorkflowRepository,
  ) {}
  async transaction<T>(operation: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL statement_timeout='5s'");
      const result = await operation(db);
      await db.query("COMMIT");
      return result;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  async event(
    db: PoolClient,
    task: TaskRow,
    type: string,
    actor: TaskActor,
    change: unknown = null,
    from: number | null = null,
    reason: string | null = null,
  ) {
    await db.query(
      `INSERT INTO scheduled_task_events(id,task_id,event_type,actor_type,actor_id,source_execution_id,from_version,to_version,change_data,reason_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [
        randomUUID(),
        task.id,
        type,
        actor.kind,
        actor.id,
        actor.executionId ?? null,
        from,
        task.version,
        JSON.stringify(change),
        reason,
      ],
    );
  }
  async settings() {
    await this.pool.query(
      "WITH restored AS (INSERT INTO scheduled_task_restore_guard(id) VALUES(1) ON CONFLICT(id) DO NOTHING RETURNING id) UPDATE scheduled_task_settings SET paused=true,paused_at=now(),version=version+1,updated_at=now() WHERE id=1 AND EXISTS(SELECT 1 FROM restored)",
    );
    return (
      await this.pool.query<{
        paused: boolean;
        pending_limit: number;
        catchup_minutes: number;
        version: number;
      }>("SELECT * FROM scheduled_task_settings WHERE id=1")
    ).rows[0]!;
  }
  async configure(input: {
    paused: boolean;
    pendingLimit: number;
    catchupMinutes: number;
    expectedVersion: number;
  }) {
    return this.transaction(async (db) => {
      const old = (
        await db.query<{ paused: boolean; version: number }>(
          "SELECT * FROM scheduled_task_settings WHERE id=1 FOR UPDATE",
        )
      ).rows[0]!;
      if (old.version !== input.expectedVersion)
        throw new TaskError("TASK_VERSION_CONFLICT");
      // Global pause stops unsubmitted sends. Resume skips the paused interval lazily.
      if (old.paused && !input.paused)
        await db.query(
          "UPDATE scheduled_tasks SET resume_after=now() WHERE lifecycle='active'",
        );
      return (
        await db.query<Record<string, unknown>>(
          `UPDATE scheduled_task_settings SET paused=$1,pending_limit=$2,catchup_minutes=$3,paused_at=CASE WHEN $1 THEN COALESCE(paused_at,now()) ELSE NULL END,version=version+1,updated_at=now() WHERE id=1 RETURNING *`,
          [input.paused, input.pendingLimit, input.catchupMinutes],
        )
      ).rows[0];
    });
  }
  async binding(workflowId: string, providerChatId: string) {
    const bindings = (await this.workflows.listActiveTriggerBindings()).filter(
      (t) =>
        taskConfig(t)?.enabled &&
        taskConfig(t)?.chatIds.includes(providerChatId),
    );
    if (bindings.length !== 1 || bindings[0]?.workflowId !== workflowId)
      throw new TaskError("TASK_CONFIGURATION_UNAVAILABLE");
    return bindings[0];
  }
  private async scope(executionId: string, db: Pool | PoolClient = this.pool) {
    const row = (
      await db.query<{
        chat_id: string;
        provider_chat_id: string;
        workflow_id: string;
        sender_id: string;
        message_id: string;
        body: string;
      }>(
        `SELECT m.chat_id,c.provider_chat_id,v.workflow_id,m.sender_id,m.id AS message_id,m.body
   FROM workflow_executions e JOIN workflow_versions v ON v.id=e.workflow_version_id
   JOIN messages m ON m.id=e.source_message_id JOIN chats c ON c.id=m.chat_id
   WHERE e.id=$1 AND e.status IN ('running','created','retrying') AND e.trigger_event IS NULL AND e.retry_of_execution_id IS NULL
   AND c.enabled AND c.deleted_at IS NULL AND m.content_redacted_at IS NULL AND m.sender_id IS NOT NULL
   AND (bot_message_author(m.id)->>'kind')='participant'`,
        [executionId],
      )
    ).rows[0];
    if (!row) throw new TaskError("TASK_REQUEST_NOT_AUTHORIZED");
    const binding = await this.binding(row.workflow_id, row.provider_chat_id);
    return { ...row, binding };
  }
  async tools(executionId: string): Promise<RegisteredAgentTool[]> {
    let zone = "UTC";
    try {
      const scope = await this.scope(executionId);
      zone = taskConfig(scope.binding)!.timeZone;
    } catch (e) {
      if (e instanceof TaskError) return [];
      throw e;
    }
    const schemas = {
      create_scheduled_task: createTaskSchema,
      list_scheduled_tasks: listTasksSchema,
      update_scheduled_task: updateTaskSchema,
      cancel_scheduled_task: cancelTaskSchema,
      pause_scheduled_task: cancelTaskSchema,
      resume_scheduled_task: cancelTaskSchema,
      skip_next_scheduled_task: cancelTaskSchema,
    };
    const descriptions = {
      create_scheduled_task:
        "Create a one-time or recurring reminder only for the current user's explicit request. Confirm only after success. Provide summary (short title) and content (full instructions). Use absolute datetime with offset and IANA timezone.",
      list_scheduled_tasks:
        "List this member's reminder tasks in this chat and workflow before changing or cancelling them.",
      update_scheduled_task:
        "Change a reminder owned by this member, using the ID and version returned by list. To fill a missing summary, send only id, expectedVersion and summary; this does not reschedule or interrupt execution.",
      pause_scheduled_task:
        "Pause this member's recurring reminder. Future occurrences stop until resumed.",
      resume_scheduled_task:
        "Resume this member's recurring reminder from its next future occurrence; do not catch up paused times.",
      skip_next_scheduled_task:
        "Skip exactly one next occurrence of this member's recurring reminder, using its current version. Counts toward the occurrence limit.",
      cancel_scheduled_task:
        "Cancel this member's reminder. Sending already started cannot be guaranteed cancelled.",
    };
    return Object.entries(schemas).map(([name, schema]) => ({
      definition: {
        name,
        description:
          descriptions[name as keyof typeof descriptions] +
          ` Configured reminder timezone: ${zone}.`,
        parameters: z.toJSONSchema(schema, { io: "input" }),
      },
      diagnostics: "metadata-only" as const,
      metadata: { capability: "scheduled-task" },
      execute: async (args: string, ctx: AgentToolContext) => {
        try {
          // Reserve enough response budget BEFORE committing a mutation.
          if (ctx.maxOutputCharacters < 3000)
            return JSON.stringify({
              status: "failed",
              errorCode: "TASK_RESULT_BUDGET",
            });
          ctx.signal.throwIfAborted();
          const parsed = schema.parse(JSON.parse(args));
          const scope = await this.scope(executionId);
          const actor: TaskActor = {
            kind: "member",
            id: scope.sender_id,
            executionId,
            chatId: scope.chat_id,
            workflowId: scope.workflow_id,
          };
          if (name === "create_scheduled_task")
            return JSON.stringify({
              status: "created",
              task: publicTask(
                await this.create(
                  executionId,
                  createTaskSchema.parse(parsed),
                  ctx,
                ),
              ),
            });
          if (name === "list_scheduled_tasks") {
            const q = listTasksSchema.parse(parsed);
            const items = await this.list({
              ...q,
              chatId: scope.chat_id,
              workflowId: scope.workflow_id,
              senderId: scope.sender_id,
            });
            const output = JSON.stringify({ status: "ok", ...items });
            return output.length <= ctx.maxOutputCharacters
              ? output
              : JSON.stringify({
                  status: "failed",
                  errorCode: "TASK_RESULT_BUDGET",
                  guidance: "Request fewer tasks.",
                });
          }
          const action =
            name === "pause_scheduled_task"
              ? "pause"
              : name === "resume_scheduled_task"
                ? "resume"
                : name === "skip_next_scheduled_task"
                  ? "skip"
                  : null;
          const updated = action
            ? await this.control(
                actor,
                cancelTaskSchema.parse(parsed),
                action,
                ctx,
              )
            : await this.change(
                actor,
                name === "cancel_scheduled_task"
                  ? cancelTaskSchema.parse(parsed)
                  : updateTaskSchema.parse(parsed),
                name === "cancel_scheduled_task",
                ctx,
              );
          return JSON.stringify({ status: "ok", task: publicTask(updated) });
        } catch (e) {
          return JSON.stringify({
            status: "failed",
            errorCode:
              e instanceof TaskError
                ? e.code
                : e instanceof z.ZodError || e instanceof SyntaxError
                  ? "TASK_ARGUMENTS_INVALID"
                  : "TASK_OPERATION_FAILED",
          });
        }
      },
    }));
  }
  async create(
    executionId: string,
    input: z.infer<typeof createTaskSchema>,
    ctx: AgentToolContext,
  ): Promise<TaskRow> {
    return this.transaction(async (db) => {
      const scope = await this.scope(executionId, db);
      const actor: TaskActor = {
        kind: "member",
        id: scope.sender_id,
        executionId,
      };
      if (!ctx.toolCallId) throw new TaskError("TASK_CALL_ID_REQUIRED");
      const key = `${executionId}:${ctx.toolCallId}`;
      const settings = (
        await db.query<{
          pending_limit: number;
          catchup_minutes: number;
          now: Date;
        }>(
          "SELECT *,now() AS now FROM scheduled_task_settings WHERE id=1 FOR UPDATE",
        )
      ).rows[0]!;
      const existing = (
        await db.query<TaskRow>(
          "SELECT * FROM scheduled_tasks WHERE creation_key=$1 FOR UPDATE",
          [key],
        )
      ).rows[0];
      if (existing) return existing;
      if (
        (
          await db.query(
            "SELECT 1 FROM scheduled_task_deletions WHERE creation_key=$1",
            [key],
          )
        ).rowCount
      )
        throw new TaskError("TASK_DELETED");
      const schedule: TaskSchedule = input.schedule ?? {
        kind: "once",
        scheduledAt: input.scheduledAt!,
      };
      const at = validateSchedule(schedule, input.timeZone, settings.now);
      const counts = (
        await db.query<{ total: number; member: number }>(
          `SELECT count(*)::int AS total,count(*) FILTER(WHERE chat_id=$1 AND creator_sender_id=$2)::int AS member FROM scheduled_tasks WHERE lifecycle IN ('active','paused')`,
          [scope.chat_id, scope.sender_id],
        )
      ).rows[0]!;
      if (
        counts.total >= settings.pending_limit ||
        counts.member >= taskConfig(scope.binding)!.memberPendingLimit
      )
        throw new TaskError("TASK_PENDING_LIMIT");
      ctx.signal.throwIfAborted();
      if (Date.now() >= ctx.deadline)
        throw new TaskError("TASK_OPERATION_TIMEOUT");
      const task = (
        await db.query<TaskRow>(
          `INSERT INTO scheduled_tasks(id,chat_id,workflow_id,creator_sender_id,source_message_id,source_execution_id,request_snapshot,content,scheduled_at,timezone,expires_at,creation_key,schedule,summary)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14) RETURNING *`,
          [
            randomUUID(),
            scope.chat_id,
            scope.workflow_id,
            scope.sender_id,
            scope.message_id,
            executionId,
            scope.body?.slice(0, 8000) ?? "",
            input.content,
            at,
            input.timeZone,
            new Date(
              at.getTime() + Math.max(1, settings.catchup_minutes) * 60000,
            ),
            key,
            JSON.stringify(schedule),
            input.summary,
          ],
        )
      ).rows[0]!;
      await this.ensureOccurrence(db, task);
      await this.event(db, task, "created", actor, {
        scheduledAt: input.scheduledAt,
        timeZone: input.timeZone,
      });
      if (
        JSON.stringify({ status: "created", task: publicTask(task) }).length >
        ctx.maxOutputCharacters
      )
        throw new TaskError("TASK_RESULT_BUDGET");
      ctx.signal.throwIfAborted();
      if (Date.now() >= ctx.deadline)
        throw new TaskError("TASK_OPERATION_TIMEOUT");
      return task;
    });
  }
  private checkContext(ctx?: AgentToolContext) {
    ctx?.signal.throwIfAborted();
    if (ctx && Date.now() >= ctx.deadline)
      throw new TaskError("TASK_OPERATION_TIMEOUT");
  }
  private async owned(db: PoolClient, actor: TaskActor, id: string) {
    const task = (
      await db.query<TaskRow>(
        "SELECT * FROM scheduled_tasks WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (
      !task ||
      (actor.kind === "member" &&
        (task.creator_sender_id !== actor.id ||
          task.chat_id !== actor.chatId ||
          task.workflow_id !== actor.workflowId))
    )
      throw new TaskError("TASK_NOT_FOUND");
    if (actor.executionId) await this.scope(actor.executionId, db);
    return task;
  }
  async change(
    actor: TaskActor,
    input: {
      id: string;
      expectedVersion: number;
      summary?: string | undefined;
      content?: string | undefined;
      scheduledAt?: string | undefined;
      timeZone?: string | undefined;
      schedule?: TaskSchedule | undefined;
    },
    cancel: boolean,
    ctx?: AgentToolContext,
  ): Promise<TaskRow> {
    return this.mutate(actor, input, cancel ? "cancel" : "update", ctx);
  }
  async control(
    actor: TaskActor,
    input: { id: string; expectedVersion: number },
    action: "pause" | "resume" | "skip",
    ctx?: AgentToolContext,
  ): Promise<TaskRow> {
    return this.mutate(actor, input, action, ctx);
  }
  private async mutate(
    actor: TaskActor,
    input: {
      id: string;
      expectedVersion: number;
      summary?: string | undefined;
      content?: string | undefined;
      scheduledAt?: string | undefined;
      timeZone?: string | undefined;
      schedule?: TaskSchedule | undefined;
    },
    action: "update" | "cancel" | "pause" | "resume" | "skip",
    ctx?: AgentToolContext,
  ): Promise<TaskRow> {
    return this.transaction(async (db) => {
      const task = await this.owned(db, actor, input.id);
      const key =
        actor.executionId && ctx?.toolCallId
          ? `${actor.executionId}:${ctx.toolCallId}`
          : null;
      if (key) {
        const previous = (
          await db.query<{ result: TaskRow }>(
            "SELECT result FROM scheduled_task_operations WHERE operation_key=$1 AND task_id=$2",
            [key, task.id],
          )
        ).rows[0];
        if (previous)
          return {
            ...previous.result,
            scheduled_at: new Date(previous.result.scheduled_at),
            expires_at: new Date(previous.result.expires_at),
          };
      }
      if (task.version !== input.expectedVersion)
        throw new TaskError("TASK_VERSION_CONFLICT");
      const summaryOnly =
        action === "update" &&
        input.summary !== undefined &&
        input.content === undefined &&
        input.schedule === undefined &&
        input.scheduledAt === undefined &&
        input.timeZone === undefined;
      if (summaryOnly) {
        if (task.content === null) throw new TaskError("TASK_CONTENT_CLEARED");
        this.checkContext(ctx);
        const updated = (
          await db.query<TaskRow>(
            "UPDATE scheduled_tasks SET summary=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
            [task.id, input.summary],
          )
        ).rows[0]!;
        await this.event(
          db,
          updated,
          "summary-updated",
          actor,
          { fields: ["summary"] },
          task.version,
        );
        if (
          ctx &&
          JSON.stringify(publicTask(updated)).length + 100 >
            ctx.maxOutputCharacters
        )
          throw new TaskError("TASK_RESULT_BUDGET");
        this.checkContext(ctx);
        if (key)
          await db.query(
            "INSERT INTO scheduled_task_operations(operation_key,task_id,result) VALUES($1,$2,$3::jsonb)",
            [key, task.id, JSON.stringify(updated)],
          );
        return updated;
      }
      if (!["active", "paused"].includes(task.lifecycle))
        throw new TaskError("TASK_ALREADY_FINISHED");
      if (
        ["pause", "resume", "skip"].includes(action) &&
        task.schedule.kind !== "recurring"
      )
        throw new TaskError("TASK_RECURRING_REQUIRED");
      if (
        (action === "resume" && task.lifecycle !== "paused") ||
        ((action === "pause" || action === "skip") &&
          task.lifecycle !== "active")
      )
        throw new TaskError("TASK_STATE_INVALID");
      const sending = !!(
        await db.query(
          "SELECT 1 FROM scheduled_task_runs WHERE task_id=$1 AND phase='sending' AND outcome IS NULL",
          [task.id],
        )
      ).rowCount;
      if (
        sending &&
        (task.schedule.kind === "once" ||
          action === "update" ||
          action === "skip")
      )
        throw new TaskError("TASK_SENDING_ALREADY_STARTED");
      const settings = (
        await db.query<{ now: Date; catchup_minutes: number }>(
          "SELECT now() AS now,catchup_minutes FROM scheduled_task_settings WHERE id=1",
        )
      ).rows[0]!;
      let schedule = input.schedule ?? task.schedule;
      const zone = input.timeZone ?? task.timezone;
      if (input.scheduledAt) {
        if (task.schedule.kind !== "once" || input.schedule)
          throw new TaskError("TASK_LEGACY_UPDATE_UNSUPPORTED");
        schedule = { kind: "once", scheduledAt: input.scheduledAt };
      }
      if (input.timeZone && !input.schedule && !input.scheduledAt)
        throw new TaskError("TASK_TIME_REQUIRED_WITH_TIMEZONE");
      if (input.schedule && input.schedule.kind !== task.schedule.kind)
        throw new TaskError("TASK_KIND_IMMUTABLE");
      if (
        schedule.kind === "recurring" &&
        schedule.end.kind === "count" &&
        schedule.end.count < task.consumed_count
      )
        throw new TaskError("TASK_COUNT_BELOW_CONSUMED");
      let at: Date | null = task.scheduled_at;
      let lifecycle = task.lifecycle;
      if (action === "update" && (input.schedule || input.scheduledAt)) {
        if (
          schedule.kind === "recurring" &&
          schedule.end.kind === "count" &&
          schedule.end.count === task.consumed_count
        )
          at = null;
        else
          at = validateSchedule(
            schedule,
            zone,
            settings.now,
            task.schedule.kind === "once" ? 0 : task.consumed_count,
          );
      } else if (
        action === "update" &&
        task.status === "running" &&
        schedule.kind === "recurring"
      )
        at = nextScheduledTime(
          schedule,
          zone,
          task.scheduled_at,
          task.consumed_count,
        );
      else if (
        action === "update" &&
        task.lifecycle === "active" &&
        at <= settings.now
      )
        throw new TaskError("TASK_TIME_OUT_OF_RANGE");
      if (action === "cancel") lifecycle = "cancelled";
      if (action === "pause") lifecycle = "paused";
      if (action === "resume") {
        lifecycle = "active";
        at = nextScheduledTime(
          schedule,
          zone,
          settings.now,
          task.consumed_count,
        );
      }
      if (action === "skip") {
        const occurrence = await this.ensureOccurrence(db, task);
        if (!occurrence.consumed) {
          task.consumed_count++;
          await db.query(
            "UPDATE scheduled_tasks SET consumed_count=consumed_count+1 WHERE id=$1",
            [task.id],
          );
        }
        await db.query(
          "UPDATE scheduled_task_occurrences SET consumed=true,status='skipped',reason_code='member-skipped',finished_at=now() WHERE id=$1",
          [occurrence.id],
        );
        at = nextScheduledTime(
          schedule,
          zone,
          task.scheduled_at,
          task.consumed_count,
        );
      }
      if (!sending) {
        await db.query(
          "UPDATE scheduled_task_occurrences SET status='cancelled',reason_code='task-changed',finished_at=now() WHERE task_id=$1 AND status IN ('pending','running')",
          [task.id],
        );
        await db.query(
          "UPDATE workflow_executions e SET status='skipped',completed_at=now(),error_code='TASK_CHANGED' FROM scheduled_task_runs r WHERE r.execution_id=e.id AND r.task_id=$1 AND r.outcome IS NULL AND e.status IN ('created','running','retrying')",
          [task.id],
        );
        await db.query(
          "UPDATE scheduled_task_runs SET outcome='cancelled',reason_code='task-changed',phase='finished',finished_at=now() WHERE task_id=$1 AND outcome IS NULL",
          [task.id],
        );
      }
      if (at === null && (lifecycle === "active" || lifecycle === "paused"))
        lifecycle = "completed";
      this.checkContext(ctx);
      const updated = (
        await db.query<TaskRow>(
          `UPDATE scheduled_tasks SET content=$2,schedule=$3::jsonb,timezone=$4,scheduled_at=$5,expires_at=$6,lifecycle=$7,status=$8,version=version+1,execution_version=execution_version+1,summary=$10,finished_at=CASE WHEN $7 IN ('completed','cancelled') THEN now() ELSE NULL END,updated_at=now(),resume_after=$9 WHERE id=$1 RETURNING *`,
          [
            task.id,
            input.content ?? task.content,
            JSON.stringify(schedule),
            zone,
            at ?? task.scheduled_at,
            new Date(
              (at ?? task.scheduled_at).getTime() +
                Math.max(1, settings.catchup_minutes) * 60000,
            ),
            lifecycle,
            lifecycle === "active"
              ? sending
                ? "running"
                : "pending"
              : lifecycle,
            sending && action === "resume" ? settings.now : null,
            input.summary ?? task.summary,
          ],
        )
      ).rows[0]!;
      updated.sendingAlreadyStarted = sending;
      await this.event(
        db,
        updated,
        action,
        actor,
        {
          before: publicTask(task),
          after: publicTask(updated),
          sendingAlreadyStarted: sending,
        },
        task.version,
      );
      if (
        ctx &&
        JSON.stringify(publicTask(updated)).length + 100 >
          ctx.maxOutputCharacters
      )
        throw new TaskError("TASK_RESULT_BUDGET");
      this.checkContext(ctx);
      if (key)
        await db.query(
          "INSERT INTO scheduled_task_operations(operation_key,task_id,result) VALUES($1,$2,$3::jsonb)",
          [key, task.id, JSON.stringify(updated)],
        );
      return updated;
    });
  }
  async ensureOccurrence(db: PoolClient, task: TaskRow) {
    const existing = (
      await db.query<{
        id: string;
        consumed: boolean;
        occurrence_number: string;
      }>(
        "SELECT * FROM scheduled_task_occurrences WHERE task_id=$1 AND status IN ('pending','running')",
        [task.id],
      )
    ).rows[0];
    if (existing) return existing;
    const sequence = (
      await db.query<{ occurrence_sequence: string }>(
        "UPDATE scheduled_tasks SET occurrence_sequence=occurrence_sequence+1 WHERE id=$1 RETURNING occurrence_sequence",
        [task.id],
      )
    ).rows[0]!.occurrence_sequence;
    return (
      await db.query<{
        id: string;
        consumed: boolean;
        occurrence_number: string;
      }>(
        `INSERT INTO scheduled_task_occurrences(id,task_id,occurrence_number,task_version,scheduled_at,expires_at,snapshot,status) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'pending') RETURNING *`,
        [
          randomUUID(),
          task.id,
          sequence,
          task.execution_version,
          task.scheduled_at,
          task.expires_at,
          JSON.stringify({
            content: task.content,
            requestSnapshot: task.request_snapshot,
            schedule: task.schedule,
          }),
        ],
      )
    ).rows[0]!;
  }
  /** Called only by the authenticated administrator API, never a model tool. */
  async remove(id: string, expectedVersion: number) {
    return this.transaction(async (db) => {
      const task = (
        await db.query<TaskRow>(
          "SELECT * FROM scheduled_tasks WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!task) {
        const prior = (
          await db.query<{ version: number }>(
            "SELECT version FROM scheduled_task_deletions WHERE task_id=$1",
            [id],
          )
        ).rows[0];
        if (!prior) throw new TaskError("TASK_NOT_FOUND");
        if (prior.version !== expectedVersion)
          throw new TaskError("TASK_VERSION_CONFLICT");
        return { id, deleted: true };
      }
      if (task.version !== expectedVersion)
        throw new TaskError("TASK_VERSION_CONFLICT");
      if (!(await this.canRemove(db, task)))
        throw new TaskError("TASK_DELETE_NOT_FINISHED");
      await this.deleteLocked(db, task, "manual");
      return { id, deleted: true };
    });
  }
  private async canRemove(db: PoolClient, task: TaskRow) {
    if (
      !["completed", "cancelled"].includes(task.lifecycle) ||
      task.finished_at === null
    )
      return false;
    return !(
      await db.query(
        `SELECT 1 FROM scheduled_task_runs r JOIN workflow_executions e ON e.id=r.execution_id WHERE r.task_id=$1 AND (r.outcome IS NULL OR e.status IN ('created','running','retrying'))
       UNION ALL SELECT 1 FROM scheduled_task_occurrences WHERE task_id=$1 AND status IN ('pending','running') LIMIT 1`,
        [task.id],
      )
    ).rowCount;
  }
  private async deleteLocked(
    db: PoolClient,
    task: TaskRow,
    reason: "manual" | "retention",
  ) {
    await db.query(
      "INSERT INTO scheduled_task_deletions(task_id,creation_key,version,reason) SELECT id,creation_key,version,$2 FROM scheduled_tasks WHERE id=$1",
      [task.id, reason],
    );
    // Keep execution identities and delivery evidence, remove the task payload copy.
    await db.query(
      `UPDATE workflow_executions e SET trigger_event=jsonb_set(jsonb_set(e.trigger_event,'{scheduled,content}','""'::jsonb),'{scheduled,requestSnapshot}','""'::jsonb) FROM scheduled_task_runs r WHERE r.task_id=$1 AND r.execution_id=e.id AND e.trigger_event->>'schemaVersion' IN ('scheduled-task-v1','scheduled-task-v2')`,
      [task.id],
    );
    await db.query("DELETE FROM scheduled_task_operations WHERE task_id=$1", [
      task.id,
    ]);
    await db.query("DELETE FROM scheduled_task_events WHERE task_id=$1", [
      task.id,
    ]);
    await db.query("DELETE FROM scheduled_task_runs WHERE task_id=$1", [
      task.id,
    ]);
    await db.query("DELETE FROM scheduled_task_occurrences WHERE task_id=$1", [
      task.id,
    ]);
    await db.query("DELETE FROM scheduled_tasks WHERE id=$1", [task.id]);
    if (reason === "retention")
      await db.query(
        `INSERT INTO audit_events(id,actor_type,action,target_type,target_id,outcome,correlation_id,metadata) VALUES($1,'system','scheduled-task.expire','scheduled-task',$2,'succeeded',$1,'{"retentionDays":90}'::jsonb)`,
        [randomUUID(), task.id],
      );
  }
  async purgeExpired(): Promise<number> {
    return this.transaction(async (db) => {
      const tasks = (
        await db.query<TaskRow>(
          `SELECT t.* FROM scheduled_tasks t WHERE t.lifecycle IN ('completed','cancelled') AND t.finished_at < now()-interval '90 days'
         AND NOT EXISTS(SELECT 1 FROM scheduled_task_runs r JOIN workflow_executions e ON e.id=r.execution_id WHERE r.task_id=t.id AND (r.outcome IS NULL OR e.status IN ('created','running','retrying')))
         AND NOT EXISTS(SELECT 1 FROM scheduled_task_occurrences o WHERE o.task_id=t.id AND o.status IN ('pending','running'))
         ORDER BY t.finished_at,t.id LIMIT 25 FOR UPDATE OF t SKIP LOCKED`,
        )
      ).rows;
      for (const task of tasks) await this.deleteLocked(db, task, "retention");
      return tasks.length;
    });
  }
  async list(options: {
    workflowId?: string | undefined;
    chatId?: string | undefined;
    senderId?: string | undefined;
    status?: string | undefined;
    lifecycle?: string | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
  }) {
    const limit = options.limit ?? 20;
    const result = await this.pool.query<
      TaskRow & {
        chat_name: string;
        workflow_name: string;
        creator_real_name: string | null;
      }
    >(
      `SELECT t.*,c.display_name AS chat_name,w.name AS workflow_name,i.real_name AS creator_real_name FROM scheduled_tasks t JOIN chats c ON c.id=t.chat_id JOIN workflows w ON w.id=t.workflow_id
   LEFT JOIN chat_participant_identities i ON i.chat_id=t.chat_id AND i.sender_id=t.creator_sender_id
   WHERE ($1::uuid IS NULL OR t.workflow_id=$1) AND ($2::uuid IS NULL OR t.chat_id=$2) AND ($3::text IS NULL OR t.creator_sender_id=$3) AND ($4::text IS NULL OR t.status=$4) AND ($7::text IS NULL OR t.lifecycle=$7) ORDER BY t.scheduled_at DESC,t.id DESC LIMIT $5 OFFSET $6`,
      [
        options.workflowId ?? null,
        options.chatId ?? null,
        options.senderId ?? null,
        options.status ?? null,
        limit + 1,
        options.offset ?? 0,
        options.lifecycle ?? null,
      ],
    );
    return {
      items: result.rows.slice(0, limit).map((t) => ({
        ...publicTask(t),
        chatId: t.chat_id,
        chatName: t.chat_name,
        workflowId: t.workflow_id,
        workflowName: t.workflow_name,
        creatorSenderId: t.creator_sender_id,
        creatorRealName: t.creator_real_name,
      })),
      hasMore: result.rows.length > limit,
    };
  }
  async detail(id: string, offset = 0, limit = 20) {
    const task = (
      await this.pool.query<TaskRow & { creator_real_name: string | null }>(
        `SELECT t.*,i.real_name AS creator_real_name FROM scheduled_tasks t
         LEFT JOIN chat_participant_identities i ON i.chat_id=t.chat_id AND i.sender_id=t.creator_sender_id
         WHERE t.id=$1`,
        [id],
      )
    ).rows[0];
    if (!task) throw new TaskError("TASK_NOT_FOUND");
    const events = (
      await this.pool.query<Record<string, unknown>>(
        "SELECT * FROM scheduled_task_events WHERE task_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",
        [id],
      )
    ).rows;
    const runs = (
      await this.pool.query<Record<string, unknown>>(
        "SELECT * FROM scheduled_task_runs WHERE task_id=$1 ORDER BY accepted_at DESC,id DESC LIMIT $2 OFFSET $3",
        [id, limit, offset],
      )
    ).rows;
    const occurrences = (
      await this.pool.query<{
        id: string;
        occurrence_number: string;
        scheduled_at: Date;
        status: string;
        reason_code: string | null;
        execution_id: string | null;
        snapshot: unknown;
      }>(
        "SELECT o.*,r.execution_id FROM scheduled_task_occurrences o LEFT JOIN scheduled_task_runs r ON r.occurrence_id=o.id WHERE o.task_id=$1 ORDER BY o.occurrence_number DESC LIMIT $2 OFFSET $3",
        [id, limit + 1, offset],
      )
    ).rows;
    return {
      task,
      summary: publicTask(task),
      events,
      runs,
      occurrences: occurrences.slice(0, limit),
      hasMore: occurrences.length > limit,
    };
  }
}
