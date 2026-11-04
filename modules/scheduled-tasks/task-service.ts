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
  validateTaskTime,
} from "./task-policy.js";

export interface TaskRow {
  id: string;
  chat_id: string;
  workflow_id: string;
  creator_sender_id: string;
  source_message_id: string | null;
  source_execution_id: string | null;
  request_snapshot: string | null;
  content: string | null;
  scheduled_at: Date;
  timezone: string;
  expires_at: Date;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
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
function publicTask(t: TaskRow) {
  return {
    id: t.id,
    content: t.content,
    scheduledAt: t.scheduled_at.toISOString(),
    timeZone: t.timezone,
    status: t.status,
    version: t.version,
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
      "WITH restored AS (INSERT INTO scheduled_task_restore_guard(id) VALUES(1) ON CONFLICT(id) DO NOTHING RETURNING id) UPDATE scheduled_task_settings SET paused=true,version=version+1,updated_at=now() WHERE id=1 AND EXISTS(SELECT 1 FROM restored)",
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
    const row = await this.pool.query<Record<string, unknown>>(
      `UPDATE scheduled_task_settings SET paused=$1,pending_limit=$2,catchup_minutes=$3,version=version+1,updated_at=now() WHERE id=1 AND version=$4 RETURNING *`,
      [
        input.paused,
        input.pendingLimit,
        input.catchupMinutes,
        input.expectedVersion,
      ],
    );
    if (!row.rowCount) throw new TaskError("TASK_VERSION_CONFLICT");
    return row.rows[0];
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
    };
    const descriptions = {
      create_scheduled_task:
        "Create a one-time reminder only for the current user's explicit request. Confirm only after success. Use absolute datetime with offset and IANA timezone.",
      list_scheduled_tasks:
        "List this member's reminder tasks in this chat and workflow before changing or cancelling them.",
      update_scheduled_task:
        "Change a reminder owned by this member, using the ID and version returned by list.",
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
          const updated = await this.change(
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
          "SELECT * FROM scheduled_tasks WHERE creation_key=$1",
          [key],
        )
      ).rows[0];
      if (existing) return existing;
      const at = validateTaskTime(
        input.scheduledAt,
        input.timeZone,
        settings.now,
      );
      const counts = (
        await db.query<{ total: number; member: number }>(
          `SELECT count(*)::int AS total,count(*) FILTER(WHERE chat_id=$1 AND creator_sender_id=$2)::int AS member FROM scheduled_tasks WHERE status IN ('pending','running')`,
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
          `INSERT INTO scheduled_tasks(id,chat_id,workflow_id,creator_sender_id,source_message_id,source_execution_id,request_snapshot,content,scheduled_at,timezone,expires_at,creation_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
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
          ],
        )
      ).rows[0]!;
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
  async change(
    actor: TaskActor,
    input: {
      id: string;
      expectedVersion: number;
      content?: string | undefined;
      scheduledAt?: string | undefined;
      timeZone?: string | undefined;
    },
    cancel: boolean,
    ctx?: AgentToolContext,
  ): Promise<TaskRow> {
    return this.transaction(async (db) => {
      const task = (
        await db.query<TaskRow>(
          "SELECT * FROM scheduled_tasks WHERE id=$1 FOR UPDATE",
          [input.id],
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
      if (task.version !== input.expectedVersion)
        throw new TaskError("TASK_VERSION_CONFLICT");
      if (!["pending", "running"].includes(task.status))
        throw new TaskError("TASK_ALREADY_FINISHED");
      const sending = await db.query(
        "SELECT 1 FROM scheduled_task_runs WHERE task_id=$1 AND phase='sending' AND outcome IS NULL",
        [task.id],
      );
      if (sending.rowCount) throw new TaskError("TASK_SENDING_ALREADY_STARTED");
      const settings = (
        await db.query<{ catchup_minutes: number; now: Date }>(
          "SELECT *,now() AS now FROM scheduled_task_settings WHERE id=1",
        )
      ).rows[0]!;
      const zone = input.timeZone ?? task.timezone;
      if (input.timeZone && !input.scheduledAt)
        throw new TaskError("TASK_TIME_REQUIRED_WITH_TIMEZONE");
      const at = input.scheduledAt
        ? validateTaskTime(input.scheduledAt, zone, settings.now)
        : task.scheduled_at;
      if (!cancel && at <= settings.now)
        throw new TaskError("TASK_TIME_OUT_OF_RANGE");
      ctx?.signal.throwIfAborted();
      if (ctx && Date.now() >= ctx.deadline)
        throw new TaskError("TASK_OPERATION_TIMEOUT");
      const updated = (
        await db.query<TaskRow>(
          `UPDATE scheduled_tasks SET content=$2,scheduled_at=$3,timezone=$4,expires_at=$5,status=$6,version=version+1,updated_at=now(),finished_at=CASE WHEN $6='cancelled' THEN now() ELSE NULL END WHERE id=$1 RETURNING *`,
          [
            task.id,
            input.content ?? task.content,
            at,
            zone,
            input.scheduledAt
              ? new Date(
                  at.getTime() + Math.max(1, settings.catchup_minutes) * 60000,
                )
              : task.expires_at,
            cancel ? "cancelled" : "pending",
          ],
        )
      ).rows[0]!;
      await db.query(
        "UPDATE scheduled_task_runs SET outcome='cancelled',reason_code='task-changed',phase='finished',finished_at=now() WHERE task_id=$1 AND outcome IS NULL",
        [task.id],
      );
      await this.event(
        db,
        updated,
        cancel ? "cancelled" : "updated",
        actor,
        { before: publicTask(task), after: publicTask(updated) },
        task.version,
      );
      if (ctx) {
        if (
          JSON.stringify({ status: "ok", task: publicTask(updated) }).length >
          ctx.maxOutputCharacters
        )
          throw new TaskError("TASK_RESULT_BUDGET");
        ctx.signal.throwIfAborted();
        if (Date.now() >= ctx.deadline)
          throw new TaskError("TASK_OPERATION_TIMEOUT");
      }
      return updated;
    });
  }
  async list(options: {
    workflowId?: string | undefined;
    chatId?: string | undefined;
    senderId?: string | undefined;
    status?: string | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
  }) {
    const limit = options.limit ?? 20;
    const result = await this.pool.query<
      TaskRow & { chat_name: string; workflow_name: string }
    >(
      `SELECT t.*,c.display_name AS chat_name,w.name AS workflow_name FROM scheduled_tasks t JOIN chats c ON c.id=t.chat_id JOIN workflows w ON w.id=t.workflow_id
   WHERE ($1::uuid IS NULL OR t.workflow_id=$1) AND ($2::uuid IS NULL OR t.chat_id=$2) AND ($3::text IS NULL OR t.creator_sender_id=$3) AND ($4::text IS NULL OR t.status=$4) ORDER BY t.scheduled_at DESC,t.id DESC LIMIT $5 OFFSET $6`,
      [
        options.workflowId ?? null,
        options.chatId ?? null,
        options.senderId ?? null,
        options.status ?? null,
        limit + 1,
        options.offset ?? 0,
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
      })),
      hasMore: result.rows.length > limit,
    };
  }
  async detail(id: string) {
    const task = (
      await this.pool.query<TaskRow>(
        "SELECT * FROM scheduled_tasks WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!task) throw new TaskError("TASK_NOT_FOUND");
    const events = (
      await this.pool.query<Record<string, unknown>>(
        "SELECT * FROM scheduled_task_events WHERE task_id=$1 ORDER BY created_at,id",
        [id],
      )
    ).rows;
    const runs = (
      await this.pool.query<Record<string, unknown>>(
        "SELECT * FROM scheduled_task_runs WHERE task_id=$1 ORDER BY accepted_at,id",
        [id],
      )
    ).rows;
    return { task, events, runs };
  }
}
