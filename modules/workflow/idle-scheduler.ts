import { DEFAULT_CONTEXT_SETTINGS } from "./context-settings-types.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  idleDay,
  idleDueAt,
  isQuiet,
  quietUntil,
  type IdleTriggerConfig,
} from "./idle-policy.js";
import type { ChatIdleEvent } from "./workflow-event.js";
import type { WorkflowEngine } from "./workflow-engine.js";
import type {
  TriggerBinding,
  WorkflowRepository,
} from "./workflow-repository.js";

interface Activity {
  chat_id: string;
  provider_chat_id: string;
  type: "direct" | "group" | "unknown";
  display_name: string | null;
  generation: string;
  consumed_generation: string;
  last_activity_at: Date;
  last_human_at: Date | null;
  next_message_index: string;
  last_message_index: string;
}
interface Candidate {
  activity: Activity;
  trigger: TriggerBinding;
  config: IdleTriggerConfig;
  due: Date;
}
export class IdleScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  constructor(
    private readonly pool: Pool,
    private readonly repository: WorkflowRepository,
    private readonly engine: WorkflowEngine,
    private readonly timeZone: string,
    private readonly now: () => Date = () => new Date(),
    private readonly reportError: () => void = () => undefined,
  ) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.schedule(), 30_000);
    this.timer.unref();
    this.schedule();
  }
  private schedule(): void {
    if (this.running) return;
    this.running = this.tick()
      .catch(() => this.reportError())
      .finally(() => {
        this.running = undefined;
      });
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
  async settings() {
    const row = (
      await this.pool.query<{ daily_limit: number; version: number }>(
        "SELECT daily_limit,version FROM idle_settings WHERE id=1",
      )
    ).rows[0]!;
    return {
      dailyLimit: row.daily_limit,
      version: row.version,
      timeZone: this.timeZone,
    };
  }
  async updateSettings(dailyLimit: number, expectedVersion: number) {
    const result = await this.pool.query(
      "UPDATE idle_settings SET daily_limit=$1,version=version+1,updated_at=now() WHERE id=1 AND version=$2 RETURNING id",
      [dailyLimit, expectedVersion],
    );
    return result.rowCount ? this.settings() : null;
  }
  private config(trigger: TriggerBinding): IdleTriggerConfig | undefined {
    const node = trigger.definition.nodes.find(
      (node) => node.type === "message-trigger",
    );
    return node?.type === "message-trigger" && node.config.idle?.enabled
      ? node.config.idle
      : undefined;
  }
  private async activities(
    db: Pool | PoolClient = this.pool,
  ): Promise<Activity[]> {
    return (
      await db.query<Activity>(`SELECT a.*,c.provider_chat_id,c.type,c.display_name,c.next_message_index
      FROM idle_chat_activity a JOIN chats c ON c.id=a.chat_id
      WHERE c.enabled AND c.deleted_at IS NULL AND c.provider='bluebubbles'
      AND EXISTS(SELECT 1 FROM messages m WHERE m.chat_id=c.id AND m.message_index=a.last_message_index AND m.content_redacted_at IS NULL)`)
    ).rows;
  }
  async preview(workflowId: string) {
    const bindings = (await this.repository.listActiveTriggerBindings()).filter(
      (t) => t.workflowId === workflowId,
    );
    const activities = await this.activities();
    const now = this.now();
    const results = [];
    for (const trigger of bindings) {
      const config = this.config(trigger);
      if (!config) continue;
      for (const chatId of config.chatIds) {
        const activity = activities.find((a) => a.provider_chat_id === chatId);
        const eligible =
          !!activity?.last_human_at &&
          activity.last_human_at > new Date(trigger.updatedAt) &&
          BigInt(activity.generation) > BigInt(activity.consumed_generation);
        const due = activity
          ? idleDueAt(activity.last_activity_at, config, now)
          : null;
        const limits = await this.settings();
        const counts = activity
          ? (
              await this.pool.query<{
                instance_count: string;
                workflow_count: string;
              }>(
                `SELECT count(*) FILTER(WHERE instance_day=$2)::text AS instance_count,
           count(*) FILTER(WHERE workflow_day=$3 AND workflow_version_id IN(SELECT id FROM workflow_versions WHERE workflow_id=$4))::text AS workflow_count
           FROM idle_attempts WHERE chat_id=$1 AND state IN ('reserved','confirmed','unknown')`,
                [
                  activity.chat_id,
                  idleDay(now, this.timeZone),
                  idleDay(now, config.timeZone),
                  workflowId,
                ],
              )
            ).rows[0]
          : undefined;
        const workflowRemaining = Math.max(
          0,
          config.dailyLimit - Number(counts?.workflow_count ?? 0),
        );
        const instanceRemaining = Math.max(
          0,
          limits.dailyLimit - Number(counts?.instance_count ?? 0),
        );
        results.push({
          chatId,
          workflowRemaining,
          instanceRemaining,
          lastActivityAt: activity?.last_activity_at.toISOString() ?? null,
          eligible,
          earliestTriggerAt: due?.toISOString() ?? null,
          quiet: isQuiet(now, config),
          quietUntil: quietUntil(now, config)?.toISOString() ?? null,
          reason: !activity
            ? "chat-unavailable-or-no-activity"
            : !eligible
              ? "waiting-for-human"
              : !workflowRemaining || !instanceRemaining
                ? "daily-limit"
                : isQuiet(now, config)
                  ? "quiet-hours"
                  : due && due > now
                    ? "waiting-for-idle"
                    : "eligible",
        });
      }
    }
    return results;
  }
  async tick(): Promise<void> {
    await this.pool
      .query(`UPDATE workflow_executions e SET status='skipped',completed_at=now(),error_code='idle-stale-attempt',error_summary='空闲任务已失效'
      FROM idle_attempts a JOIN idle_chat_activity activity ON activity.chat_id=a.chat_id
      JOIN chats c ON c.id=a.chat_id JOIN bot_triggers t ON t.id=a.trigger_id
      JOIN workflow_versions v ON v.id=a.workflow_version_id JOIN workflows w ON w.id=v.workflow_id
      WHERE a.execution_id=e.id AND e.status IN ('created','running','retrying')
      AND (a.generation<>activity.generation OR NOT c.enabled OR c.deleted_at IS NOT NULL
        OR NOT t.enabled OR t.deleted_at IS NOT NULL OR w.status<>'active' OR w.deleted_at IS NOT NULL
        OR t.workflow_version_id<>a.workflow_version_id
        OR date_trunc('milliseconds',GREATEST(t.updated_at,w.updated_at))<>a.trigger_updated_at
        OR NOT EXISTS(SELECT 1 FROM messages m WHERE m.chat_id=c.id AND m.message_index=(e.trigger_event->'idle'->>'lastMessageIndex')::bigint AND m.content_redacted_at IS NULL))
      AND NOT EXISTS(SELECT 1 FROM outbound_deliveries d WHERE d.execution_id=e.id)`);
    await this.reconcile();
    const triggers = await this.repository.listActiveTriggerBindings();
    const activities = await this.activities();
    const now = this.now();
    const candidates: Candidate[] = [];
    for (const activity of activities) {
      for (const trigger of triggers) {
        const config = this.config(trigger);
        if (
          !config ||
          !config.chatIds.includes(activity.provider_chat_id) ||
          !activity.last_human_at ||
          activity.last_human_at <= new Date(trigger.updatedAt)
        )
          continue;
        const due = idleDueAt(activity.last_activity_at, config, now);
        await this.pool.query(
          `INSERT INTO idle_trigger_checks(trigger_id,chat_id,workflow_version_id,generation,next_check_at)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(trigger_id,chat_id) DO UPDATE SET workflow_version_id=$3,generation=$4,next_check_at=$5,updated_at=now()
          WHERE (idle_trigger_checks.workflow_version_id,idle_trigger_checks.generation,idle_trigger_checks.next_check_at) IS DISTINCT FROM ($3::uuid,$4::bigint,$5::timestamptz)`,
          [
            trigger.id,
            activity.chat_id,
            trigger.workflowVersionId,
            activity.generation,
            due,
          ],
        );
        if (due && due <= now && !isQuiet(now, config))
          candidates.push({ activity, trigger, config, due });
      }
    }
    candidates.sort(
      (a, b) =>
        a.due.getTime() - b.due.getTime() ||
        a.trigger.id.localeCompare(b.trigger.id),
    );
    const selected = new Map<string, Candidate>();
    for (const candidate of candidates)
      if (!selected.has(candidate.activity.chat_id))
        selected.set(candidate.activity.chat_id, candidate);
    // Bounded batches: long generations in one chat cannot consume the entire connection pool.
    const list = [...selected.values()];
    for (let i = 0; i < list.length; i += 2)
      await Promise.allSettled(
        list.slice(i, i + 2).map((candidate) => this.dispatch(candidate)),
      ).then((results) => {
        for (const result of results)
          if (result.status === "rejected") this.reportError();
      });
  }
  private async dispatch(candidate: Candidate): Promise<void> {
    const db = await this.pool.connect();
    const lock = `idle-chat:${candidate.activity.chat_id}`;
    let locked = false;
    try {
      locked =
        (
          await db.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
            [lock],
          )
        ).rows[0]?.locked ?? false;
      if (!locked) return;
      const { activity, trigger, config } = candidate;
      const event: ChatIdleEvent = {
        schemaVersion: "chat-idle-v1",
        eventId: `idle:${activity.chat_id}:${activity.generation}`,
        correlationId: randomUUID(),
        provider: "bluebubbles",
        message: null,
        chat: {
          providerChatId: activity.provider_chat_id,
          type: activity.type,
          displayName: activity.display_name,
        },
        idle: {
          chatId: activity.chat_id,
          activityGeneration: activity.generation,
          lastActivityAt: activity.last_activity_at.toISOString(),
          lastMessageIndex: activity.last_message_index,
          upperMessageIndex: activity.next_message_index,
          triggeredAt: this.now().toISOString(),
          workflowVersionId: trigger.workflowVersionId,
          taskInstruction: config.taskInstruction,
        },
      };
      await this.engine.handleIdle({
        trigger,
        event,
        accept: async () => {
          await db.query("BEGIN");
          try {
            const current = (
              await db.query<Activity>(
                "SELECT * FROM idle_chat_activity WHERE chat_id=$1 FOR UPDATE",
                [activity.chat_id],
              )
            ).rows[0];
            if (
              !current ||
              current.generation !== activity.generation ||
              current.last_activity_at.getTime() !==
                activity.last_activity_at.getTime()
            ) {
              await db.query("ROLLBACK");
              return null;
            }
            const existing = (
              await db.query<{
                execution_id: string | null;
                trigger_id: string;
                state: string;
              }>(
                "SELECT execution_id,trigger_id,state FROM idle_attempts WHERE chat_id=$1 AND generation=$2",
                [activity.chat_id, activity.generation],
              )
            ).rows[0];
            if (existing) {
              await db.query("COMMIT");
              if (
                existing.trigger_id !== trigger.id ||
                !["accepted", "reserved"].includes(existing.state) ||
                !existing.execution_id
              )
                return null;
              const previousExecution = await this.repository.getExecution(
                existing.execution_id,
              );
              if (
                !previousExecution ||
                !["created", "running", "retrying"].includes(
                  previousExecution.status,
                )
              )
                return null;
              const deliveries = await db.query<{ status: string }>(
                "SELECT status FROM outbound_deliveries WHERE execution_id=$1",
                [existing.execution_id],
              );
              if (deliveries.rowCount) {
                await this.repository.finishExecution(
                  existing.execution_id,
                  deliveries.rows.every((d) => d.status === "confirmed")
                    ? "succeeded"
                    : "dead-lettered",
                  {
                    code: "IDLE_SEND_INTERRUPTED",
                    summary:
                      "主动投递已存在，停止自动重新生成或发送，请核对投递结果。",
                  },
                );
                return null;
              }
              const recovered = await db.query(
                "UPDATE workflow_executions SET recovery_attempt=recovery_attempt+1 WHERE id=$1 AND recovery_attempt<3 AND status IN ('created','running','retrying') RETURNING id",
                [existing.execution_id],
              );
              if (!recovered.rowCount) {
                await this.repository.finishExecution(
                  existing.execution_id,
                  "failed",
                  {
                    code: "IDLE_RECOVERY_LIMIT",
                    summary: "主动任务恢复次数已达上限。",
                  },
                );
                return null;
              }
              await db.query(
                "UPDATE node_executions SET status='failed',completed_at=now(),error_code='IDLE_EXECUTION_INTERRUPTED',error_summary='进程中断后恢复' WHERE execution_id=$1 AND status='running'",
                [existing.execution_id],
              );
              const execution = await this.repository.getExecution(
                existing.execution_id,
              );
              return execution &&
                ["created", "running", "retrying"].includes(execution.status)
                ? execution
                : null;
            }
            if (
              BigInt(current.consumed_generation) >= BigInt(current.generation)
            ) {
              await db.query("ROLLBACK");
              return null;
            }
            const id = randomUUID();
            const snapshot = (
              await db.query<{ snapshot: unknown }>(
                `SELECT
              COALESCE((SELECT snapshot FROM conversation_context_windows WHERE chat_id=$1 AND trigger_message_index<$2 ORDER BY trigger_message_index DESC LIMIT 1),
                jsonb_build_object('contract','raw-context-v1','afterMessageIndex',
                  (SELECT COALESCE(min(message_index)-1,0)::text FROM (SELECT message_index FROM messages WHERE chat_id=$1 AND message_index<$2 AND (s.include_from_me OR NOT is_from_me) AND content_redacted_at IS NULL ORDER BY message_index DESC LIMIT s.base_message_window) recent),
                  'settings',jsonb_build_object('includeFromMe',s.include_from_me,'baseMessageWindow',s.base_message_window,'redundancyMessageWindow',s.redundancy_message_window,'characterLimit',s.character_limit),
                  'settingsVersion',s.version,'compatibilityInitialized',true))
                || jsonb_build_object('chatId',$1::text,'triggerMessageIndex',$2::text) AS snapshot
              FROM (
                SELECT include_from_me,base_message_window,redundancy_message_window,character_limit,version
                FROM conversation_context_settings WHERE id=1
                UNION ALL
                SELECT $3::boolean,$4::integer,$5::integer,$6::integer,0
                WHERE NOT EXISTS (SELECT 1 FROM conversation_context_settings WHERE id=1)
              ) s`,
                [
                  activity.chat_id,
                  activity.next_message_index,
                  DEFAULT_CONTEXT_SETTINGS.includeFromMe,
                  DEFAULT_CONTEXT_SETTINGS.baseMessageWindow,
                  DEFAULT_CONTEXT_SETTINGS.redundancyMessageWindow,
                  DEFAULT_CONTEXT_SETTINGS.characterLimit,
                ],
              )
            ).rows[0]?.snapshot;
            if (!snapshot)
              throw new Error("Idle context settings unavailable.");
            // Execution and qualification consumption commit together.
            await db.query(
              `INSERT INTO workflow_executions(id,provider,external_event_id,trigger_id,workflow_version_id,correlation_id,status,target_chat_id,trigger_event,trigger_message_index,context_snapshot)
              VALUES($1,'bluebubbles',$2,$3,$4,$5,'created',$6,$7::jsonb,$8,$9::jsonb)`,
              [
                id,
                event.eventId,
                trigger.id,
                trigger.workflowVersionId,
                event.correlationId,
                activity.chat_id,
                JSON.stringify(event),
                activity.next_message_index,
                JSON.stringify(snapshot),
              ],
            );
            await db.query(
              `INSERT INTO idle_attempts(id,chat_id,generation,trigger_id,workflow_version_id,execution_id,trigger_updated_at,state)
              VALUES($1,$2,$3,$4,$5,$6,$7,'accepted')`,
              [
                randomUUID(),
                activity.chat_id,
                activity.generation,
                trigger.id,
                trigger.workflowVersionId,
                id,
                trigger.updatedAt,
              ],
            );
            await db.query(
              "UPDATE idle_chat_activity SET consumed_generation=generation WHERE chat_id=$1",
              [activity.chat_id],
            );
            await db.query("COMMIT");
            return this.repository.getExecution(id);
          } catch (error) {
            await db.query("ROLLBACK");
            throw error;
          }
        },
        guard: (id, sending) => this.guardExecution(id, sending),
      });
      await this.reconcile(activity.chat_id);
    } finally {
      if (locked)
        await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          lock,
        ]);
      db.release();
    }
  }
  async guardExecution(
    executionId: string,
    sending = true,
  ): Promise<string | null> {
    const execution = await this.repository.getExecution(executionId);
    if (!execution) return "idle-execution-unavailable";
    if (!execution.triggerEvent) return null;
    if (
      ["skipped", "failed", "dead-lettered", "closed"].includes(
        execution.status,
      )
    )
      return "idle-execution-ended";
    const event = execution.triggerEvent;
    const attempt = (
      await this.pool.query<{ trigger_updated_at: Date }>(
        "SELECT trigger_updated_at FROM idle_attempts WHERE execution_id=$1",
        [executionId],
      )
    ).rows[0];
    const trigger = (await this.repository.listActiveTriggerBindings()).find(
      (t) => t.id === execution.triggerId,
    );
    if (
      !trigger ||
      !attempt ||
      trigger.workflowVersionId !== event.idle.workflowVersionId ||
      new Date(trigger.updatedAt).getTime() !==
        attempt.trigger_updated_at.getTime()
    )
      return "idle-configuration-changed";
    const config = this.config(trigger);
    if (!config || !config.chatIds.includes(event.chat.providerChatId))
      return "idle-configuration-changed";
    const activity: Activity = {
      chat_id: event.idle.chatId,
      provider_chat_id: event.chat.providerChatId,
      type: event.chat.type,
      display_name: event.chat.displayName,
      generation: event.idle.activityGeneration,
      consumed_generation: event.idle.activityGeneration,
      last_activity_at: new Date(event.idle.lastActivityAt),
      last_human_at: null,
      next_message_index: event.idle.upperMessageIndex,
      last_message_index: event.idle.lastMessageIndex,
    };
    return this.guard(
      executionId,
      { activity, trigger, config, due: new Date(event.idle.triggeredAt) },
      sending,
    );
  }
  private async guard(
    executionId: string,
    candidate: Candidate,
    sending: boolean,
  ): Promise<string | null> {
    const { activity, trigger, config } = candidate;
    const textConfirmed = !!(
      await this.pool.query(
        "SELECT 1 FROM outbound_deliveries WHERE execution_id=$1 AND kind='text' AND status='confirmed'",
        [executionId],
      )
    ).rowCount;
    if (!sending && textConfirmed) return null;
    const live = (await this.repository.listActiveTriggerBindings()).find(
      (t) => t.id === trigger.id,
    );
    if (
      !live ||
      live.workflowVersionId !== trigger.workflowVersionId ||
      live.updatedAt !== trigger.updatedAt ||
      !this.config(live)?.chatIds.includes(activity.provider_chat_id)
    )
      return "idle-configuration-changed";
    const now = this.now();
    if (isQuiet(now, config)) return "idle-quiet-hours";
    const current = (await this.activities()).find(
      (a) => a.chat_id === activity.chat_id,
    );
    if (!current) return "idle-chat-unavailable";
    if (
      current.generation !== activity.generation ||
      current.last_message_index !== activity.last_message_index ||
      (!textConfirmed &&
        current.last_activity_at.getTime() !==
          activity.last_activity_at.getTime())
    )
      return "idle-new-activity";
    const due = idleDueAt(current.last_activity_at, config, now);
    if (!textConfirmed && (!due || due > now)) return "idle-not-due";
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      // Serialize quota reservation with activity changes and other workflows.
      await db.query(
        "SELECT 1 FROM idle_chat_activity WHERE chat_id=$1 FOR UPDATE",
        [activity.chat_id],
      );
      const row = (
        await db.query<{
          generation: string;
          last_activity_at: Date;
          last_message_index: string;
        }>(
          "SELECT generation,last_activity_at,last_message_index FROM idle_chat_activity WHERE chat_id=$1",
          [activity.chat_id],
        )
      ).rows[0];
      if (
        !row ||
        row.generation !== activity.generation ||
        row.last_message_index !== activity.last_message_index ||
        (!textConfirmed &&
          row.last_activity_at.getTime() !==
            activity.last_activity_at.getTime())
      ) {
        await db.query("ROLLBACK");
        return "idle-new-activity";
      }
      const instanceDay = idleDay(now, this.timeZone),
        workflowDay = idleDay(now, config.timeZone);
      const counts = (
        await db.query<{
          instance_count: string;
          workflow_count: string;
          daily_limit: number;
        }>(
          `SELECT (SELECT daily_limit FROM idle_settings WHERE id=1) AS daily_limit,
          count(*) FILTER(WHERE instance_day=$2)::text AS instance_count,
          count(*) FILTER(WHERE workflow_day=$3 AND workflow_version_id IN (SELECT id FROM workflow_versions WHERE workflow_id=$4))::text AS workflow_count
         FROM idle_attempts WHERE chat_id=$1 AND state IN ('reserved','confirmed','unknown') AND execution_id<>$5`,
          [
            activity.chat_id,
            instanceDay,
            workflowDay,
            trigger.workflowId,
            executionId,
          ],
        )
      ).rows[0]!;
      if (
        Number(counts.instance_count) >= counts.daily_limit ||
        Number(counts.workflow_count) >= config.dailyLimit
      ) {
        await db.query("ROLLBACK");
        return "idle-daily-limit";
      }
      if (sending)
        await db.query(
          "UPDATE idle_attempts SET state='reserved',instance_day=$2,workflow_day=$3,updated_at=now() WHERE execution_id=$1 AND state IN ('accepted','reserved')",
          [executionId, instanceDay, workflowDay],
        );
      await db.query("COMMIT");
      return null;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  private async reconcile(chatId: string | null = null): Promise<void> {
    await this.pool.query(
      `UPDATE idle_attempts a SET state=CASE
      WHEN EXISTS(SELECT 1 FROM outbound_deliveries d WHERE d.execution_id=a.execution_id AND d.status='confirmed') THEN 'confirmed'
      WHEN EXISTS(SELECT 1 FROM outbound_deliveries d WHERE d.execution_id=a.execution_id AND d.status IN ('sending','unknown','pending')) THEN 'unknown'
      ELSE 'released' END,updated_at=now()
      FROM workflow_executions e WHERE e.id=a.execution_id AND ($1::uuid IS NULL OR a.chat_id=$1) AND a.state IN ('accepted','reserved')
      AND e.status NOT IN ('created','running','retrying')`,
      [chatId],
    );
  }
}
