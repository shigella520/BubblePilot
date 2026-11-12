import { parseWorkflowDefinition } from "./workflow-definition.js";
import { parseTriggerConditions } from "./trigger-matcher.js";
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
  last_activity_source: "human" | "bot" | "unknown";
  next_message_index: string;
  last_message_index: string;
}
interface Candidate {
  activity: Activity;
  trigger: TriggerBinding;
  config: IdleTriggerConfig;
  due: Date;
  event?: ChatIdleEvent;
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
  settings() {
    return { timeZone: this.timeZone };
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
  async history(
    workflowId: string,
    options: {
      offset?: number;
      limit?: number;
      chatId?: string | undefined;
      status?: string | undefined;
    } = {},
  ) {
    const limit = options.limit ?? 20;
    const result = await this.pool.query<{
      id: string;
      chatId: string;
      chatName: string | null;
      createdAt: Date;
      completedAt: Date | null;
      version: number;
      status: string;
      reason: string | null;
      skipReason: string | null;
      requestCount: number;
      requests: Array<{
        provider: string;
        model: string;
        status: string;
        httpStatus: number | null;
      }>;
      provider: string | null;
      model: string | null;
    }>(
      `SELECT e.id,c.provider_chat_id AS "chatId",c.display_name AS "chatName",e.created_at AS "createdAt",e.completed_at AS "completedAt",v.version,
      CASE WHEN a.state='unknown' THEN 'unknown' ELSE e.status END AS status,
      COALESCE(n.output_summary->>'reason',e.error_code) AS reason,n.output_summary->>'skipReason' AS "skipReason",
      (SELECT count(*)::int FROM ai_provider_attempts p WHERE p.execution_id=e.id) AS "requestCount",
      p.provider_name AS provider,p.model,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('provider',r.provider_name,'model',r.model,'status',r.status,'httpStatus',r.http_status) ORDER BY r.created_at) FROM ai_provider_attempts r WHERE r.execution_id=e.id),'[]'::jsonb) AS requests
      FROM idle_attempts a JOIN workflow_executions e ON e.id=a.execution_id
      JOIN workflow_versions v ON v.id=e.workflow_version_id JOIN chats c ON c.id=a.chat_id
      LEFT JOIN LATERAL (SELECT output_summary FROM node_executions WHERE execution_id=e.id AND node_type='ai-chat' ORDER BY started_at DESC LIMIT 1) n ON true
      LEFT JOIN LATERAL (SELECT provider_name,model FROM ai_provider_attempts WHERE execution_id=e.id ORDER BY created_at DESC LIMIT 1) p ON true
      WHERE v.workflow_id=$1 AND ($2::text IS NULL OR c.provider_chat_id=$2)
      AND ($3::text IS NULL OR CASE WHEN a.state='unknown' THEN 'unknown' ELSE e.status END=$3)
      ORDER BY e.created_at DESC,e.id DESC LIMIT $4 OFFSET $5`,
      [
        workflowId,
        options.chatId ?? null,
        options.status ?? null,
        limit + 1,
        options.offset ?? 0,
      ],
    );
    return {
      items: result.rows.slice(0, limit),
      hasMore: result.rows.length > limit,
    };
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
          activity?.last_activity_source === "human" &&
          !!activity.last_human_at &&
          activity.last_human_at > new Date(trigger.updatedAt) &&
          BigInt(activity.generation) > BigInt(activity.consumed_generation);
        const due = activity
          ? idleDueAt(activity.last_activity_at, config, now)
          : null;
        const counts = activity
          ? (
              await this.pool.query<{
                workflow_count: string;
              }>(
                `SELECT count(*) FILTER(WHERE workflow_day=$2 AND workflow_version_id IN(SELECT id FROM workflow_versions WHERE workflow_id=$3))::text AS workflow_count
           FROM idle_attempts WHERE chat_id=$1 AND state IN ('reserved','confirmed','unknown')`,
                [activity.chat_id, idleDay(now, config.timeZone), workflowId],
              )
            ).rows[0]
          : undefined;
        const workflowRemaining = Math.max(
          0,
          config.dailyLimit - Number(counts?.workflow_count ?? 0),
        );
        const latest =
          (await this.history(workflowId, { chatId, limit: 1 })).items[0] ??
          null;
        const running =
          latest && ["created", "running", "retrying"].includes(latest.status);
        results.push({
          chatId,
          chatName: activity?.display_name ?? latest?.chatName ?? null,
          dailyLimit: config.dailyLimit,
          latest,
          workflowRemaining,
          lastActivityAt: activity?.last_activity_at.toISOString() ?? null,
          eligible,
          earliestTriggerAt:
            eligible && !running && workflowRemaining > 0
              ? (due?.toISOString() ?? null)
              : null,
          quiet: isQuiet(now, config),
          quietUntil: quietUntil(now, config)?.toISOString() ?? null,
          reason: running
            ? "running"
            : !activity
              ? "chat-unavailable-or-no-activity"
              : activity.last_activity_source !== "human"
                ? activity.last_activity_source === "bot"
                  ? "last-message-bot"
                  : "last-message-unknown"
                : !eligible
                  ? "waiting-for-human"
                  : !workflowRemaining
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
          activity.last_activity_source !== "human" ||
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
    // Accepted runs retain their original event and configuration, including
    // after a restart. New activity/configuration only affects future attempts.
    const selected = new Map<string, Candidate>();
    for (const candidate of await this.pendingCandidates())
      if (!selected.has(candidate.activity.chat_id))
        selected.set(candidate.activity.chat_id, candidate);
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
  private async pendingCandidates(): Promise<Candidate[]> {
    const pending = await this.pool.query<{
      execution_id: string;
      trigger_updated_at: Date;
      conditions: unknown;
      definition: unknown;
      include_from_me: boolean;
    }>(`SELECT a.execution_id,a.trigger_updated_at,t.conditions,t.include_from_me,v.definition
      FROM idle_attempts a JOIN workflow_executions e ON e.id=a.execution_id
      JOIN bot_triggers t ON t.id=a.trigger_id
      JOIN workflow_versions v ON v.id=a.workflow_version_id
      WHERE a.state IN ('accepted','reserved') AND e.status IN ('created','running','retrying')
      ORDER BY a.created_at,a.id`);
    const candidates: Candidate[] = [];
    for (const row of pending.rows) {
      const execution = await this.repository.getExecution(row.execution_id);
      const event = execution?.triggerEvent;
      if (!execution || event?.schemaVersion !== "chat-idle-v1") continue;
      const trigger: TriggerBinding = {
        id: execution.triggerId,
        name: execution.triggerName,
        workflowId: execution.workflowId,
        workflowVersionId: execution.workflowVersionId,
        workflowVersion: execution.workflowVersion,
        definition: parseWorkflowDefinition(row.definition),
        conditions: parseTriggerConditions(row.conditions),
        includeFromMe: row.include_from_me,
        enabled: true,
        createdAt: execution.createdAt,
        updatedAt: row.trigger_updated_at.toISOString(),
      };
      const config = this.config(trigger);
      if (!config) continue;
      candidates.push({
        trigger,
        config,
        event,
        due: new Date(event.idle.triggeredAt),
        activity: {
          chat_id: event.idle.chatId,
          provider_chat_id: event.chat.providerChatId,
          type: event.chat.type,
          display_name: event.chat.displayName,
          generation: event.idle.activityGeneration,
          consumed_generation: event.idle.activityGeneration,
          last_activity_at: new Date(event.idle.lastActivityAt),
          last_human_at: null,
          last_activity_source: "unknown",
          next_message_index: event.idle.upperMessageIndex,
          last_message_index: event.idle.lastMessageIndex,
        },
      });
    }
    return candidates;
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
      const event: ChatIdleEvent = candidate.event ?? {
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
      await this.engine.handleBackground({
        trigger,
        event,
        accept: async () => {
          await db.query("BEGIN");
          try {
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
              // Preserve reservations for accepted rows from earlier releases.
              await db.query(
                "UPDATE idle_attempts SET state='reserved',workflow_day=COALESCE(workflow_day,$2),updated_at=now() WHERE execution_id=$1 AND state='accepted'",
                [
                  existing.execution_id,
                  idleDay(new Date(event.idle.triggeredAt), config.timeZone),
                ],
              );
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
            const current = (
              await db.query<Activity>(
                "SELECT * FROM idle_chat_activity WHERE chat_id=$1 FOR UPDATE",
                [activity.chat_id],
              )
            ).rows[0];
            if (
              !current ||
              current.last_activity_source !== "human" ||
              current.generation !== activity.generation ||
              current.last_message_index !== activity.last_message_index ||
              current.last_activity_at.getTime() !==
                activity.last_activity_at.getTime()
            ) {
              await db.query("ROLLBACK");
              return null;
            }
            const authorized = await db.query(
              `SELECT 1 FROM bot_triggers t JOIN workflow_versions v ON v.id=t.workflow_version_id JOIN workflows w ON w.id=v.workflow_id
              JOIN chats c ON c.id=$2
              WHERE t.id=$1 AND t.enabled AND t.deleted_at IS NULL
              AND w.status='active' AND w.deleted_at IS NULL
              AND c.enabled AND c.deleted_at IS NULL
              AND t.workflow_version_id=$3
              AND date_trunc('milliseconds',GREATEST(t.updated_at,w.updated_at))=$4
              AND EXISTS(SELECT 1 FROM messages m WHERE m.chat_id=c.id AND m.message_index=$5 AND m.content_redacted_at IS NULL)`,
              [
                trigger.id,
                activity.chat_id,
                trigger.workflowVersionId,
                trigger.updatedAt,
                activity.last_message_index,
              ],
            );
            const now = this.now();
            const due = idleDueAt(current.last_activity_at, config, now);
            if (
              !authorized.rowCount ||
              !config.chatIds.includes(activity.provider_chat_id) ||
              !current.last_human_at ||
              current.last_human_at <= new Date(trigger.updatedAt) ||
              !due ||
              due > now ||
              isQuiet(now, config)
            ) {
              await db.query("ROLLBACK");
              return null;
            }
            const workflowDay = idleDay(now, config.timeZone);
            const counts = await db.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM idle_attempts a JOIN workflow_versions v ON v.id=a.workflow_version_id
              WHERE a.chat_id=$1 AND v.workflow_id=$2 AND a.workflow_day=$3
              AND a.state IN ('reserved','confirmed','unknown')`,
              [activity.chat_id, trigger.workflowId, workflowDay],
            );
            if (Number(counts.rows[0]!.count) >= config.dailyLimit) {
              await db.query("ROLLBACK");
              return null;
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
              `INSERT INTO idle_attempts(id,chat_id,generation,trigger_id,workflow_version_id,execution_id,trigger_updated_at,state,workflow_day)
              VALUES($1,$2,$3,$4,$5,$6,$7,'reserved',$8)`,
              [
                randomUUID(),
                activity.chat_id,
                activity.generation,
                trigger.id,
                trigger.workflowVersionId,
                id,
                trigger.updatedAt,
                workflowDay,
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
        guard: (id) => this.guardExecution(id),
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
  async guardExecution(executionId: string): Promise<string | null> {
    // Only execution lifecycle remains a send fence. Idle eligibility and quota
    // were checked/reserved atomically at acceptance, not again per message part.
    const execution = await this.repository.getExecution(executionId);
    if (!execution) return "idle-execution-unavailable";
    if (execution.triggerEvent?.schemaVersion !== "chat-idle-v1") return null;
    if (
      ["skipped", "failed", "dead-lettered", "closed"].includes(
        execution.status,
      )
    )
      return "idle-execution-ended";
    const attempt = await this.pool.query(
      "SELECT 1 FROM idle_attempts WHERE execution_id=$1 AND state IN ('accepted','reserved','confirmed','unknown')",
      [executionId],
    );
    return attempt.rowCount ? null : "idle-execution-unavailable";
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
