import { serializeTriggerConfig } from "../apps/web/src/utils/workflow-trigger-config.js";
import { ConversationContextService } from "../modules/workflow/conversation-context-service.js";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";
import { PostgresWorkflowRepository } from "../modules/workflow/postgres-workflow-repository.js";
import { WorkflowEngine } from "../modules/workflow/workflow-engine.js";
import { createDefaultNodeRegistry } from "../modules/workflow/node-registry.js";
import { TaskScheduler } from "../modules/scheduled-tasks/task-scheduler.js";
import { TaskService } from "../modules/scheduled-tasks/task-service.js";
import { parseWorkflowDefinition } from "../modules/workflow/workflow-definition.js";
import { parseTriggerConditions } from "../modules/workflow/trigger-matcher.js";
import { AgentRunner } from "../modules/ai/agent-runner.js";
import { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";
import type { AiRouteSuccess } from "../modules/ai/ai-types.js";
import type { DeliveryResult } from "../modules/integrations/bluebubbles/reply-gateway.js";
const url = process.env.TEST_DATABASE_URL;
const success = (text: string): AiRouteSuccess => ({
  status: "succeeded",
  text,
  toolCalls: [],
  providerId: randomUUID(),
  providerName: "Fictional",
  providerVersion: 1,
  model: "fictional",
  routeVersion: 1,
  round: 1,
  attemptCount: 1,
  durationMs: 1,
  diagnostics: null,
});
describe.runIf(!!url)("scheduled tasks with PostgreSQL", () => {
  let pool: Pool,
    repository: PostgresWorkflowRepository,
    archive: PostgresArchiveRepository;
  const workflowIds: string[] = [];
  const contexts: ConversationContextService[] = [];
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    repository = new PostgresWorkflowRepository(url!);
    archive = new PostgresArchiveRepository(url!);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(contexts.splice(0).map((c) => c.close()));
    for (const id of workflowIds.splice(0))
      await repository.setWorkflowEnabled(id, false);
  });
  afterAll(async () => {
    await Promise.all([pool.end(), repository.close(), archive.close()]);
  });
  async function setup(
    result: DeliveryResult = {
      status: "confirmed",
      providerMessageId: "fictional-result",
    },
    loadContext = false,
    sharedMeme = false,
  ) {
    const chatId = `fictional-idle-${randomUUID()}`;
    let now = new Date(Date.now() + 60_000);
    const config = {
      enabled: true,
      chatIds: [chatId],
      timeZone: "UTC",
      memberPendingLimit: 20,
    };
    const definition = parseWorkflowDefinition({
      schemaVersion: "1",
      name: chatId,
      startNodeId: "message-trigger",
      nodes: [
        ...(loadContext
          ? [
              {
                id: "context",
                type: "load-context",
                version: 1,
                config: {},
                onSuccess: "ai",
              },
            ]
          : []),
        {
          id: "message-trigger",
          type: "message-trigger",
          version: 1,
          config: JSON.parse(
            JSON.stringify(
              serializeTriggerConfig({ enabled: true, scheduled: config }),
            ),
          ) as Record<string, unknown>,
          onSuccess: loadContext ? "context" : "ai",
        },
        {
          id: "ai",
          type: "ai-chat",
          version: 1,
          inputs: {
            prompt: { kind: "path", path: "context.event.message.text" },
          },
          config: {
            providerRouteId: randomUUID(),
            systemPrompt: "Fictional friendly role",
            promptTemplate: "Respond naturally",
            outputVariable: "reply",
            includeLoadedContext: loadContext,
            allowMemes: sharedMeme,
            ...(sharedMeme
              ? { pluginIds: [randomUUID()], webSearch: "auto" }
              : {}),
          },
          onSuccess: "reply",
        },
        {
          id: "reply",
          type: "reply",
          version: 1,
          config: { text: "{{variables.reply}}" },
          ...(sharedMeme
            ? {
                inputs: {
                  text: { kind: "output", blockId: "ai", port: "text" },
                  meme: { kind: "output", blockId: "ai", port: "meme" },
                },
              }
            : {}),
          onSuccess: "end",
        },
        { id: "end", type: "end", version: 1, config: {} },
      ],
    });
    const version = await repository.createWorkflow(chatId, definition);
    workflowIds.push(version.workflowId);
    await repository.publishWorkflowVersion(version.workflowId, 1);
    const trigger = await repository.createTrigger({
      name: chatId,
      workflowId: version.workflowId,
      workflowVersion: 1,
      conditions: parseTriggerConditions({ chatIds: [chatId] }),
      includeFromMe: false,
      enabled: true,
    });
    const send = vi.fn(() => Promise.resolve(result));
    const routing = new AiRoutingService(
      new InMemoryAiRepository(),
      {
        call: () => {
          throw new Error("No real model calls");
        },
      },
      new EnvironmentSecretResolver({}),
    );
    const tasks = new TaskService(pool, repository);
    const conversationContext = new ConversationContextService(url!);
    contexts.push(conversationContext);
    const engine = new WorkflowEngine(
      repository,
      createDefaultNodeRegistry(
        repository,
        { sendReply: send },
        {
          archive,
          aiRouting: routing,
          tasks,
          conversationContext,
        },
      ),
    );
    const scheduler = new TaskScheduler(tasks, engine, () => {
      throw new Error("Unexpected scheduler failure");
    });
    async function message(
      options: {
        isFromMe?: boolean;
        replay?: boolean;
        offset?: number;
        id?: string;
      } = {},
    ) {
      const event = new BlueBubblesWebhookAdapter().normalize(
        newMessageWebhook({
          chatGuid: chatId,
          messageGuid: options.id ?? randomUUID(),
          dateCreated: now.getTime() + (options.offset ?? 0),
          isFromMe: options.isFromMe ?? false,
        }),
        randomUUID(),
      );
      if (event.kind !== "message") throw new Error("Invalid fixture");
      event.envelope.metadata.isReplay = options.replay ?? false;
      await archive.ingestMessage(event.envelope, true);
      return event.envelope;
    }
    const advance = (minutes: number) => {
      now = new Date(now.getTime() + minutes * 60_000);
    };
    return {
      scheduler,
      tasks,
      send,
      message,
      advance,
      engine,
      version,
      trigger,
      chatId,
    };
  }

  async function create(s: Awaited<ReturnType<typeof setup>>) {
    const event = await s.message();
    const binding = (await repository.listActiveTriggerBindings()).find(
      (t) => t.id === s.trigger!.id,
    )!;
    const execution = await repository.createExecution({
      envelope: event,
      trigger: binding,
    });
    const ctx = {
      toolCallId: "fictional-call",
      signal: new AbortController().signal,
      deadline: Date.now() + 60000,
      maxOutputCharacters: 10000,
    };
    const input = {
      summary: "抢火车票提醒",
      content: "提醒抢火车票",
      scheduledAt: new Date(Date.now() + 3600000).toISOString(),
      timeZone: "UTC",
    };
    const task = await s.tasks.create(execution.execution.id, input, ctx);
    return { task, ctx, input, executionId: execution.execution.id };
  }
  async function due(id: string) {
    await pool.query(
      "UPDATE scheduled_tasks SET scheduled_at=now()-interval '1 second',expires_at=now()+interval '30 minutes' WHERE id=$1",
      [id],
    );
  }
  it("resolves creator real names within each chat using the current mapping without changing ownership", async () => {
    const first = await setup();
    const second = await setup();
    const a = await create(first);
    const b = await create(second);
    expect(a.task.creator_sender_id).toBe(b.task.creator_sender_id);
    const readName = async (service: TaskService, task: typeof a.task) => {
      const list = await service.list({ workflowId: task.workflow_id });
      expect(list.items).toHaveLength(1);
      const item = list.items[0]!;
      const detail = await service.detail(task.id);
      expect(item.creatorSenderId).toBe(task.creator_sender_id);
      expect(detail.task.creator_sender_id).toBe(task.creator_sender_id);
      expect(detail.task.version).toBe(task.version);
      expect(item.creatorRealName).toBe(detail.task.creator_real_name);
      return item.creatorRealName;
    };
    expect(await readName(first.tasks, a.task)).toBeNull();
    for (const [task, name] of [
      [a.task, "林书宁"],
      [b.task, "周知远"],
    ] as const) {
      await pool.query(
        "INSERT INTO chat_participant_identities(id,chat_id,sender_id,real_name,nickname) VALUES($1,$2,$3,$4,'虚构昵称')",
        [randomUUID(), task.chat_id, task.creator_sender_id, name],
      );
    }
    expect(await readName(first.tasks, a.task)).toBe("林书宁");
    expect(await readName(second.tasks, b.task)).toBe("周知远");
    await pool.query(
      "UPDATE chat_participant_identities SET real_name='林知夏' WHERE chat_id=$1 AND sender_id=$2",
      [a.task.chat_id, a.task.creator_sender_id],
    );
    expect(await readName(first.tasks, a.task)).toBe("林知夏");
    await pool.query(
      "UPDATE chat_participant_identities SET real_name=NULL WHERE chat_id=$1 AND sender_id=$2",
      [a.task.chat_id, a.task.creator_sender_id],
    );
    // A nickname alone must not be reported as the member's real name.
    expect(await readName(first.tasks, a.task)).toBeNull();
    await pool.query(
      "DELETE FROM chat_participant_identities WHERE chat_id=$1",
      [b.task.chat_id],
    );
    expect(await readName(second.tasks, b.task)).toBeNull();
  });
  it("fills legacy summaries through the member tool, keeps occurrences and rejects stale or foreign edits", async () => {
    const s = await setup();
    const c = await create(s);
    await pool.query("UPDATE scheduled_tasks SET summary=NULL WHERE id=$1", [
      c.task.id,
    ]);
    const before = await s.tasks.detail(c.task.id);
    const tool = (await s.tasks.tools(c.executionId)).find(
      (t) => t.definition.name === "update_scheduled_task",
    )!;
    const args = JSON.stringify({
      id: c.task.id,
      expectedVersion: 1,
      summary: "火车票预订提醒",
    });
    const context = { ...c.ctx, toolCallId: "summary-call" };
    const raw = await tool.execute(args, context);
    if (typeof raw !== "string")
      throw new Error("Expected textual tool result");
    const result: unknown = JSON.parse(raw);
    expect(result).toMatchObject({
      status: "ok",
      task: { summary: "火车票预订提醒", version: 2 },
    });
    expect(await tool.execute(args, context)).toBe(raw);
    const after = await s.tasks.detail(c.task.id);
    expect(after.occurrences).toEqual(before.occurrences);
    expect(after.task).toMatchObject({
      content: c.input.content,
      scheduled_at: before.task.scheduled_at,
      execution_version: 1,
      version: 2,
    });
    expect(
      after.events.filter((e) => e.event_type === "summary-updated"),
    ).toHaveLength(1);
    await expect(
      s.tasks.change(
        { kind: "admin", id: "fixture" },
        { id: c.task.id, expectedVersion: 1, summary: "过期修改" },
        false,
      ),
    ).rejects.toThrow("TASK_VERSION_CONFLICT");
    await expect(
      s.tasks.change(
        {
          kind: "member",
          id: "other",
          chatId: c.task.chat_id,
          workflowId: c.task.workflow_id,
        },
        { id: c.task.id, expectedVersion: 2, summary: "越权修改" },
        false,
      ),
    ).rejects.toThrow("TASK_NOT_FOUND");
    await s.tasks.change(
      { kind: "admin", id: "fixture" },
      {
        id: c.task.id,
        expectedVersion: 2,
        summary: "新概要",
        content: "新的完整提醒",
      },
      false,
    );
    const changed = await s.tasks.detail(c.task.id);
    expect(changed.task).toMatchObject({
      version: 3,
      execution_version: 2,
      summary: "新概要",
      content: "新的完整提醒",
    });
    vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue(
      success("虚构提醒"),
    );
    await due(c.task.id);
    await s.scheduler.tick();
    expect(s.send).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "does not interrupt an accepted or sending reminder when only its summary changes (recurring=%s)",
    async (repeats) => {
      const s = await setup();
      const c = repeats ? await recurring(s, 4) : await create(s);
      vi.spyOn(AgentRunner.prototype, "run").mockImplementationOnce(
        async () => {
          const before = await s.tasks.detail(c.task.id);
          await s.tasks.change(
            { kind: "admin", id: "fixture" },
            { id: c.task.id, expectedVersion: 1, summary: "生成中补充概要" },
            false,
          );
          const after = await s.tasks.detail(c.task.id);
          expect(after.runs).toEqual(before.runs);
          expect(after.occurrences).toEqual(before.occurrences);
          expect(after.task).toMatchObject({
            status: "running",
            version: 2,
            execution_version: 1,
          });
          return success("虚构提醒");
        },
      );
      s.send.mockImplementationOnce(async () => {
        await s.tasks.change(
          { kind: "admin", id: "fixture" },
          { id: c.task.id, expectedVersion: 2, summary: "发送中补充概要" },
          false,
        );
        return {
          status: "confirmed",
          providerMessageId: "fixture-summary-send",
        };
      });
      if (repeats) await recurringDue(c.task.id);
      else await due(c.task.id);
      await s.scheduler.tick();
      await s.scheduler.tick();
      expect(s.send).toHaveBeenCalledTimes(1);
      const d = await s.tasks.detail(c.task.id);
      expect(d.task).toMatchObject({
        version: 3,
        execution_version: 1,
        summary: "发送中补充概要",
      });
      expect(d.runs[0]?.outcome).toBe("sent");
    },
  );
  it("allows summary-only edits of retained finished tasks but clears summaries with their content", async () => {
    const s = await setup();
    const c = await create(s);
    await s.tasks.change(
      { kind: "admin", id: "fixture" },
      { id: c.task.id, expectedVersion: 1 },
      true,
    );
    const updated = await s.tasks.change(
      { kind: "admin", id: "fixture" },
      { id: c.task.id, expectedVersion: 2, summary: "已取消的虚构提醒" },
      false,
    );
    expect(updated).toMatchObject({
      lifecycle: "cancelled",
      execution_version: 2,
      version: 3,
    });
    await pool.query(
      "UPDATE scheduled_tasks SET finished_at=now()-interval '91 days' WHERE id=$1",
      [c.task.id],
    );
    await s.scheduler.reconcile();
    expect((await s.tasks.detail(c.task.id)).task).toMatchObject({
      summary: null,
      content: null,
    });
    await expect(
      s.tasks.change(
        { kind: "admin", id: "fixture" },
        { id: c.task.id, expectedVersion: 3, summary: "不可复原" },
        false,
      ),
    ).rejects.toThrow("TASK_CONTENT_CLEARED");
  });
  it("deletes only finished tasks, rejects stale versions and retains a creation tombstone", async () => {
    const s = await setup();
    const c = await create(s);
    await expect(s.tasks.remove(c.task.id, 1)).rejects.toThrow(
      "TASK_DELETE_NOT_FINISHED",
    );
    await s.tasks.change(
      { kind: "admin", id: "fixture" },
      { id: c.task.id, expectedVersion: 1 },
      true,
    );
    await expect(s.tasks.remove(c.task.id, 1)).rejects.toThrow(
      "TASK_VERSION_CONFLICT",
    );
    expect(
      await Promise.all([
        s.tasks.remove(c.task.id, 2),
        s.tasks.remove(c.task.id, 2),
      ]),
    ).toEqual([
      { id: c.task.id, deleted: true },
      { id: c.task.id, deleted: true },
    ]);
    expect(await s.tasks.remove(c.task.id, 2)).toEqual({
      id: c.task.id,
      deleted: true,
    });
    await expect(s.tasks.detail(c.task.id)).rejects.toThrow("TASK_NOT_FOUND");
    expect(
      (await s.tasks.list({ workflowId: s.version.workflowId })).items,
    ).toEqual([]);
    await expect(s.tasks.create(c.executionId, c.input, c.ctx)).rejects.toThrow(
      "TASK_DELETED",
    );
    expect(
      (
        await pool.query(
          "SELECT creation_key,reason FROM scheduled_task_deletions WHERE task_id=$1",
          [c.task.id],
        )
      ).rows,
    ).toHaveLength(1);
    for (const table of [
      "scheduled_tasks",
      "scheduled_task_occurrences",
      "scheduled_task_runs",
      "scheduled_task_events",
      "scheduled_task_operations",
    ]) {
      const column = table === "scheduled_tasks" ? "id" : "task_id";
      expect(
        (
          await pool.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [
            c.task.id,
          ])
        ).rowCount,
      ).toBe(0);
    }
  });
  it("keeps workflow and delivery evidence when deleting a sent reminder", async () => {
    const s = await setup();
    const c = await create(s);
    vi.spyOn(AgentRunner.prototype, "run").mockImplementationOnce(async () => {
      await expect(s.tasks.remove(c.task.id, 1)).rejects.toThrow(
        "TASK_DELETE_NOT_FINISHED",
      );
      return success("虚构提醒");
    });
    await due(c.task.id);
    await s.scheduler.tick();
    const d = await s.tasks.detail(c.task.id);
    const execution = d.runs[0]!.execution_id;
    const deliveries = (
      await pool.query(
        "SELECT id,status FROM outbound_deliveries WHERE execution_id=$1",
        [execution],
      )
    ).rows;
    await s.tasks.remove(c.task.id, 1);
    expect(
      (
        await pool.query(
          "SELECT id,status FROM outbound_deliveries WHERE execution_id=$1",
          [execution],
        )
      ).rows,
    ).toEqual(deliveries);
    const saved = (
      await pool.query<{ status: string; content: string }>(
        "SELECT status,trigger_event->'scheduled'->>'content' AS content FROM workflow_executions WHERE id=$1",
        [execution],
      )
    ).rows[0];
    expect(saved).toMatchObject({ content: "" });
    expect(saved?.status).not.toBe("running");
    expect(s.send).toHaveBeenCalledTimes(1);
  });
  it("automatically removes all old terminal items while paused, preserving recent, active and paused tasks", async () => {
    const s = await setup();
    const oldIds: string[] = [];
    for (const status of [
      "sent",
      "cancelled",
      "expired",
      "failed",
      "delivery_unknown",
      "completed",
    ]) {
      const c = await create(s);
      oldIds.push(c.task.id);
      await pool.query(
        "UPDATE scheduled_tasks SET lifecycle=$2,status=$3,finished_at=now()-interval '91 days' WHERE id=$1",
        [c.task.id, status === "cancelled" ? "cancelled" : "completed", status],
      );
      await pool.query(
        "UPDATE scheduled_task_occurrences SET status='sent',finished_at=now()-interval '91 days' WHERE task_id=$1",
        [c.task.id],
      );
    }
    const active = await create(s),
      paused = await recurring(s, 4),
      recent = await create(s);
    await s.tasks.control(
      { kind: "admin", id: "fixture" },
      { id: paused.task.id, expectedVersion: 1 },
      "pause",
    );
    await s.tasks.change(
      { kind: "admin", id: "fixture" },
      { id: recent.task.id, expectedVersion: 1 },
      true,
    );
    await pool.query(
      "UPDATE scheduled_tasks SET finished_at=now()-interval '29 days',scheduled_at=now()-interval '100 days' WHERE id=$1",
      [recent.task.id],
    );
    await pool.query(
      "UPDATE scheduled_task_settings SET paused=true WHERE id=1",
    );
    try {
      await s.scheduler.tick();
      expect(
        (
          await pool.query(
            "SELECT id FROM scheduled_tasks WHERE id=ANY($1::uuid[])",
            [oldIds],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT id FROM scheduled_tasks WHERE id=ANY($1::uuid[])",
            [[active.task.id, paused.task.id, recent.task.id]],
          )
        ).rowCount,
      ).toBe(3);
      expect(
        (
          await pool.query(
            "SELECT 1 FROM audit_events WHERE action='scheduled-task.expire' AND target_id=ANY($1::text[])",
            [oldIds],
          )
        ).rowCount,
      ).toBe(6);
      await Promise.all([s.tasks.purgeExpired(), s.tasks.purgeExpired()]);
      expect(
        (
          await pool.query(
            "SELECT 1 FROM scheduled_task_deletions WHERE task_id=ANY($1::uuid[])",
            [oldIds],
          )
        ).rowCount,
      ).toBe(6);
    } finally {
      await pool.query(
        "UPDATE scheduled_task_settings SET paused=false WHERE id=1",
      );
    }
  });
  it("persists retention with version checks, protects recent tasks and audits the applied cutoff", async () => {
    const s = await setup();
    const original = await s.tasks.settings();
    expect(original.retention_days).toBe(30);
    const ended = await create(s),
      recent = await create(s),
      active = await create(s);
    for (const [task, age] of [
      [ended.task, 31],
      [recent.task, 29],
    ] as const) {
      await s.tasks.change(
        { kind: "admin", id: "fixture" },
        { id: task.id, expectedVersion: 1 },
        true,
      );
      await pool.query(
        "UPDATE scheduled_tasks SET finished_at=now()-($2::int * interval '1 day') WHERE id=$1",
        [task.id, age],
      );
    }
    try {
      const settings = {
        paused: true,
        pendingLimit: 1000,
        catchupMinutes: 30,
        expectedVersion: original.version,
        retentionDays: 180,
      };
      await s.tasks.configure(settings);
      expect((await s.tasks.settings()).retention_days).toBe(180);
      await expect(
        s.tasks.configure({ ...settings, retentionDays: 30 }),
      ).rejects.toThrow("TASK_VERSION_CONFLICT");
      for (const retentionDays of [6, 181]) {
        await expect(
          s.tasks.configure({ ...settings, retentionDays }),
        ).rejects.toThrow();
        await expect(
          pool.query(
            "UPDATE scheduled_task_settings SET retention_days=$1 WHERE id=1",
            [retentionDays],
          ),
        ).rejects.toThrow();
      }
      await s.tasks.purgeExpired();
      expect((await s.tasks.detail(ended.task.id)).task.content).not.toBeNull();
      // Older clients omit the new field, preserving a previously configured value.
      await s.tasks.configure({
        paused: true,
        pendingLimit: 999,
        catchupMinutes: 10,
        expectedVersion: original.version + 1,
      });
      expect((await s.tasks.settings()).retention_days).toBe(180);
      await s.tasks.configure({
        ...settings,
        expectedVersion: original.version + 2,
        retentionDays: 30,
      });
      await Promise.all([s.tasks.purgeExpired(), s.tasks.purgeExpired()]);
      await expect(s.tasks.detail(ended.task.id)).rejects.toThrow(
        "TASK_NOT_FOUND",
      );
      expect(
        (await s.tasks.detail(recent.task.id)).task.content,
      ).not.toBeNull();
      expect((await s.tasks.detail(active.task.id)).task.lifecycle).toBe(
        "active",
      );
      const audit = await pool.query<{ metadata: { retentionDays: number } }>(
        "SELECT metadata FROM audit_events WHERE action='scheduled-task.expire' AND target_id=$1",
        [ended.task.id],
      );
      expect(audit.rows).toEqual([{ metadata: { retentionDays: 30 } }]);
    } finally {
      await pool.query(
        "UPDATE scheduled_task_settings SET retention_days=$1,paused=$2,pending_limit=$3,catchup_minutes=$4 WHERE id=1",
        [
          original.retention_days,
          original.paused,
          original.pending_limit,
          original.catchup_minutes,
        ],
      );
    }
  });
  it("does not purge terminal definitions that still have an in-flight occurrence", async () => {
    const s = await setup();
    const c = await create(s);
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      // Other suites change workflow/chat configuration and its database trigger
      // can cancel every cancelled task's pending occurrence concurrently.
      const pending = await lock.query(
        "SELECT id FROM scheduled_task_occurrences WHERE task_id=$1 AND status='pending' FOR UPDATE",
        [c.task.id],
      );
      expect(pending.rowCount).toBe(1);
      await pool.query(
        "UPDATE scheduled_tasks SET lifecycle='cancelled',status='cancelled',finished_at=now()-interval '91 days' WHERE id=$1",
        [c.task.id],
      );
      await expect(s.tasks.remove(c.task.id, 1)).rejects.toThrow(
        "TASK_DELETE_NOT_FINISHED",
      );
      await s.tasks.purgeExpired();
      expect((await s.tasks.detail(c.task.id)).task.id).toBe(c.task.id);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
  });
  it("persists once, scopes tools, and rejects other members", async () => {
    const s = await setup();
    const c = await create(s);
    const again = await s.tasks.create(c.executionId, c.input, c.ctx);
    expect(again.id).toBe(c.task.id);
    expect(await s.tasks.tools(c.executionId)).toHaveLength(7);
    await expect(
      s.tasks.change(
        {
          kind: "member",
          id: "intruder",
          chatId: c.task.chat_id,
          workflowId: c.task.workflow_id,
        },
        { id: c.task.id, expectedVersion: 1 },
        true,
      ),
    ).rejects.toThrow("TASK_NOT_FOUND");
    await expect(
      s.tasks.change(
        { kind: "admin", id: "fictional-admin" },
        { id: c.task.id, expectedVersion: 9 },
        true,
      ),
    ).rejects.toThrow("TASK_VERSION_CONFLICT");
    const cancelled = await s.tasks.change(
      { kind: "admin", id: "fictional-admin" },
      { id: c.task.id, expectedVersion: 1 },
      true,
    );
    expect(cancelled.status).toBe("cancelled");
    await due(c.task.id);
    await s.scheduler.tick();
    expect(s.send).not.toHaveBeenCalled();
  });
  it("requests the model at due time with latest history and sends exactly once", async () => {
    const s = await setup(undefined, true, true);
    const c = await create(s);
    const model = vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue({
      ...success("五点到了，请记得抢票！"),
      selectedMeme: {
        id: randomUUID(),
        name: "fictional",
        hash: "a".repeat(64),
      },
    });
    await due(c.task.id);
    await s.scheduler.tick();
    await s.scheduler.tick();
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(model).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(model.mock.calls[0]![0].messages)).toContain(
      "scheduled_task",
    );
    expect(model.mock.calls[0]![0]).toMatchObject({
      idleDecision: false,
      pluginIds: [],
      allowMemes: false,
      webSearch: "disabled",
    });
    expect((await s.tasks.detail(c.task.id)).task.status).toBe("sent");
    const run = (await s.tasks.detail(c.task.id)).runs[0]!;
    expect(await s.tasks.tools(String(run.execution_id))).toEqual([]);
  });
  it("uses deterministic fallback when the model fails", async () => {
    const s = await setup();
    const c = await create(s);
    vi.spyOn(AgentRunner.prototype, "run").mockRejectedValue(
      new Error("Fictional outage"),
    );
    await due(c.task.id);
    await s.scheduler.tick();
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send.mock.calls[0]).toBeDefined();
    expect((await s.tasks.detail(c.task.id)).runs[0]).toMatchObject({
      generation_mode: "fallback",
      outcome: "sent",
    });
  });
  it("cancels during generation and refuses stale delivery", async () => {
    const s = await setup();
    const c = await create(s);
    vi.spyOn(AgentRunner.prototype, "run").mockImplementation(async () => {
      await s.tasks.change(
        { kind: "admin", id: "fictional-admin" },
        { id: c.task.id, expectedVersion: 1 },
        true,
      );
      return success("不要发送");
    });
    await due(c.task.id);
    await s.scheduler.tick();
    expect(s.send).not.toHaveBeenCalled();
    expect((await s.tasks.detail(c.task.id)).task.status).toBe("cancelled");
  });
  it("does not resend unknown gateway outcomes", async () => {
    const s = await setup({
      status: "unknown",
      code: "FICTIONAL_UNKNOWN",
      summary: "unknown",
    });
    const c = await create(s);
    vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue(success("提醒"));
    await due(c.task.id);
    await s.scheduler.tick();
    await s.scheduler.tick();
    expect(s.send).toHaveBeenCalledTimes(1);
    expect((await s.tasks.detail(c.task.id)).task.status).toBe(
      "delivery_unknown",
    );
  });
  it("expires stale tasks and races multiple schedulers without duplicate output", async () => {
    const s = await setup();
    const c = await create(s);
    vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue(success("提醒"));
    await due(c.task.id);
    await Promise.all([
      s.scheduler.tick(),
      new TaskScheduler(s.tasks, s.engine).tick(),
    ]);
    expect(s.send).toHaveBeenCalledTimes(1);
    const other = await create(s);
    await pool.query(
      "UPDATE scheduled_tasks SET scheduled_at=now()-interval '1 hour',expires_at=now()-interval '30 minutes' WHERE id=$1",
      [other.task.id],
    );
    await s.scheduler.tick();
    expect((await s.tasks.detail(other.task.id)).task.status).toBe("expired");
    expect(s.send).toHaveBeenCalledTimes(1);
  });
  it("rejects revoked configuration permanently and handles changed versions", async () => {
    const s = await setup();
    const c = await create(s);
    await repository.setWorkflowEnabled(s.version.workflowId, false);
    await repository.setWorkflowEnabled(s.version.workflowId, true);
    expect((await s.tasks.detail(c.task.id)).task.status).toBe("cancelled");
    await due(c.task.id);
    await s.scheduler.tick();
    expect(s.send).not.toHaveBeenCalled();
  });
  it("rolls back mutations whose complete response cannot fit", async () => {
    const s = await setup();
    const c = await create(s);
    await expect(
      s.tasks.create(
        c.executionId,
        { ...c.input, content: '"'.repeat(2000) },
        { ...c.ctx, toolCallId: "oversize", maxOutputCharacters: 3000 },
      ),
    ).rejects.toThrow("TASK_RESULT_BUDGET");
    expect(
      (await s.tasks.list({ workflowId: s.version.workflowId })).items,
    ).toHaveLength(1);
  });
  it("enforces a shared member quota under concurrent calls", async () => {
    const s = await setup();
    const c = await create(s);
    await pool.query(
      "UPDATE scheduled_task_settings SET pending_limit=1 WHERE id=1",
    );
    const result = await Promise.allSettled([
      s.tasks.create(c.executionId, c.input, {
        ...c.ctx,
        toolCallId: "quota-1",
      }),
      s.tasks.create(c.executionId, c.input, {
        ...c.ctx,
        toolCallId: "quota-2",
      }),
    ]);
    expect(result.every((r) => r.status === "rejected")).toBe(true);
    await pool.query(
      "UPDATE scheduled_task_settings SET pending_limit=1000 WHERE id=1",
    );
  });
  it("rejects cancellation after the send fence", async () => {
    const s = await setup();
    const c = await create(s);
    vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue(success("提醒"));
    s.send.mockImplementation(async () => {
      await expect(
        s.tasks.change(
          { kind: "admin", id: "fixture" },
          { id: c.task.id, expectedVersion: 1 },
          true,
        ),
      ).rejects.toThrow("TASK_SENDING_ALREADY_STARTED");
      return { status: "confirmed", providerMessageId: "fictional-fenced" };
    });
    await due(c.task.id);
    await s.scheduler.tick();
    expect(s.send).toHaveBeenCalledTimes(1);
    expect((await s.tasks.detail(c.task.id)).task.status).toBe("sent");
  });
  it("invalidates old generation after rescheduling", async () => {
    const s = await setup();
    const c = await create(s);
    vi.spyOn(AgentRunner.prototype, "run").mockImplementation(async () => {
      await s.tasks.change(
        { kind: "admin", id: "fixture" },
        {
          id: c.task.id,
          expectedVersion: 1,
          scheduledAt: new Date(Date.now() + 7200000).toISOString(),
          timeZone: "UTC",
        },
        false,
      );
      return success("旧提醒");
    });
    await due(c.task.id);
    await s.scheduler.tick();
    expect(s.send).not.toHaveBeenCalled();
    expect((await s.tasks.detail(c.task.id)).task).toMatchObject({
      status: "pending",
      version: 2,
    });
  });
  it("pauses a restored database with no restore guard", async () => {
    const s = await setup();
    const c = await create(s);
    await due(c.task.id);
    await pool.query("DELETE FROM scheduled_task_restore_guard WHERE id=1");
    await s.scheduler.tick();
    expect((await s.tasks.settings()).paused).toBe(true);
    expect(s.send).not.toHaveBeenCalled();
    await pool.query(
      "UPDATE scheduled_task_settings SET paused=false WHERE id=1",
    );
  });
  it.each(["scheduled-task-v1", "scheduled-task-v2"])(
    "recovers the same %s execution after an interrupted claim",
    async (schemaVersion) => {
      const s = await setup();
      const c = await create(s);
      await due(c.task.id);
      const claim = vi
        .spyOn(s.engine, "handleBackground")
        .mockImplementationOnce(async (input) => {
          await input.accept();
          throw new Error("fixture crash");
        });
      await expect(s.scheduler.tick()).rejects.toThrow();
      claim.mockRestore();
      const before = (await s.tasks.detail(c.task.id)).runs[0]!;
      if (schemaVersion === "scheduled-task-v1")
        await pool.query(
          `UPDATE workflow_executions SET trigger_event=jsonb_set(trigger_event #- '{scheduled,occurrenceId}' #- '{scheduled,occurrenceNumber}','{schemaVersion}','"scheduled-task-v1"'::jsonb) WHERE id=$1`,
          [before.execution_id],
        );
      await pool.query(
        "UPDATE scheduled_task_runs SET lease_expires_at=now()-interval '1 second' WHERE task_id=$1",
        [c.task.id],
      );
      vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue(
        success("恢复后的提醒"),
      );
      await new TaskScheduler(s.tasks, s.engine).tick();
      const after = (await s.tasks.detail(c.task.id)).runs;
      expect(after).toHaveLength(1);
      expect(after[0]?.execution_id).toBe(before.execution_id);
      expect(after[0]?.lease_generation).toBe(2);
      expect(s.send).toHaveBeenCalledTimes(1);
    },
  );
  it("registers tools in the real agent loop even without web search or plugins", async () => {
    const s = await setup();
    const c = await create(s);
    const routing = new AiRoutingService(
      new InMemoryAiRepository(),
      {
        call: () => {
          throw new Error("no real calls");
        },
      },
      new EnvironmentSecretResolver({}),
    );
    const execute = vi
      .spyOn(routing, "execute")
      .mockResolvedValueOnce({
        ...success(""),
        toolCalls: [
          { id: "list-test", name: "list_scheduled_tasks", arguments: "{}" },
        ],
      })
      .mockResolvedValueOnce(success("你有一个待执行提醒。"));
    const result = await new AgentRunner(routing).run({
      runtimeTools: await s.tasks.tools(c.executionId),
      executionId: c.executionId,
      nodeId: "ai",
      routeId: randomUUID(),
      messages: [{ role: "user", content: "我有哪些提醒？" }],
      maxOutputTokens: 256,
      maxOutputCharacters: 1000,
      temperature: 0,
      outputFormat: "text",
      protectedPrompt: null,
    });
    expect(result.status).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]![0].tools).toHaveLength(7);
    const second = execute.mock.calls[1]![0].messages;
    expect(
      second.some(
        (m) =>
          m.role === "tool" &&
          typeof m.content === "string" &&
          m.content.includes(c.task.id),
      ),
    ).toBe(true);
  });
  async function recurring(s: Awaited<ReturnType<typeof setup>>, count = 3) {
    const seed = await create(s);
    await s.tasks.change(
      { kind: "admin", id: "fixture" },
      { id: seed.task.id, expectedVersion: 1 },
      true,
    );
    const task = await s.tasks.create(
      seed.executionId,
      {
        summary: "虚构周期提醒",
        content: "虚构周期提醒",
        timeZone: "UTC",
        schedule: {
          kind: "recurring",
          startsAt: new Date(Date.now() + 3600000).toISOString(),
          rule: { type: "interval", everyMinutes: 60 },
          end: { kind: "count", count },
        },
      },
      { ...seed.ctx, toolCallId: "recurring-create" },
    );
    return { ...seed, task };
  }
  async function recurringDue(id: string, minutes = 1) {
    await pool.query(
      `UPDATE scheduled_tasks SET scheduled_at=now()-($2*interval '1 minute'),expires_at=now()-($2*interval '1 minute')+interval '30 minutes',schedule=jsonb_set(schedule,'{startsAt}',to_jsonb(to_char((now()-($2*interval '1 minute')) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE id=$1`,
      [id, minutes],
    );
  }
  it("reuses one recurring definition, gives each slot its own execution, and completes at count", async () => {
    const s = await setup();
    const c = await recurring(s, 2);
    vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue(
      success("周期提醒"),
    );
    await recurringDue(c.task.id);
    await Promise.all([
      s.scheduler.tick(),
      new TaskScheduler(s.tasks, s.engine).tick(),
    ]);
    let detail = await s.tasks.detail(c.task.id);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(detail.task).toMatchObject({
      lifecycle: "active",
      status: "pending",
      consumed_count: 1,
      version: 1,
    });
    const original = (await repository.getExecution(
      String(detail.runs[0]!.execution_id),
    ))!;
    expect(original.triggerEvent?.schemaVersion).toBe("scheduled-task-v2");
    await recurringDue(c.task.id);
    await s.scheduler.tick();
    await s.scheduler.tick();
    detail = await s.tasks.detail(c.task.id);
    expect(detail.task).toMatchObject({
      lifecycle: "completed",
      consumed_count: 2,
    });
    expect(s.send).toHaveBeenCalledTimes(2);
    expect(detail.runs).toHaveLength(2);
    expect(new Set(detail.runs.map((r) => r.execution_id)).size).toBe(2);
  });
  it("does not terminate recurrence on unknown delivery or replay the same slot", async () => {
    const s = await setup({
      status: "unknown",
      code: "FICTIONAL_TIMEOUT",
      summary: "fixture",
    });
    const c = await recurring(s, 2);
    vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue(success("提醒"));
    await recurringDue(c.task.id);
    await s.scheduler.tick();
    await s.scheduler.tick();
    const d = await s.tasks.detail(c.task.id);
    expect(d.task.lifecycle).toBe("active");
    expect(d.occurrences[0]?.status).toBe("delivery_unknown");
    expect(s.send).toHaveBeenCalledTimes(1);
  });
  it("compresses missed slots and catches up only the most recent eligible occurrence", async () => {
    const s = await setup();
    const c = await recurring(s, 10);
    vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue(success("补发"));
    await recurringDue(c.task.id, 181);
    await s.scheduler.tick();
    const d = await s.tasks.detail(c.task.id);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(d.task.consumed_count).toBe(4);
    expect(d.events.some((e) => e.event_type === "missed-occurrences")).toBe(
      true,
    );
    expect(d.runs).toHaveLength(1);
  });
  it("keeps quota and count while paused; resumes to a future time without catchup", async () => {
    const s = await setup();
    const c = await recurring(s, 3);
    await recurringDue(c.task.id, 181);
    const paused = await s.tasks.control(
      { kind: "admin", id: "fixture" },
      { id: c.task.id, expectedVersion: 1 },
      "pause",
    );
    await s.scheduler.tick();
    expect(s.send).not.toHaveBeenCalled();
    expect(paused.consumed_count).toBe(0);
    const resumed = await s.tasks.control(
      { kind: "admin", id: "fixture" },
      { id: c.task.id, expectedVersion: 2 },
      "resume",
    );
    expect(resumed.scheduled_at.getTime()).toBeGreaterThan(Date.now());
    expect(resumed.consumed_count).toBe(0);
    expect(resumed.lifecycle).toBe("active");
  });
  it("skips exactly one occurrence despite duplicate tools and conflicts on stale versions", async () => {
    const s = await setup();
    const c = await recurring(s, 3);
    const actor = {
      kind: "member" as const,
      id: c.task.creator_sender_id,
      executionId: c.executionId,
      chatId: c.task.chat_id,
      workflowId: c.task.workflow_id,
    };
    const args = { id: c.task.id, expectedVersion: 1 };
    const ctx = { ...c.ctx, toolCallId: "skip-once" };
    const first = await s.tasks.control(actor, args, "skip", ctx);
    const again = await s.tasks.control(actor, args, "skip", ctx);
    expect(again.version).toBe(first.version);
    expect(again.consumed_count).toBe(1);
    expect(
      (await s.tasks.detail(c.task.id)).occurrences.filter(
        (o) => o.status === "skipped",
      ),
    ).toHaveLength(1);
    await expect(
      s.tasks.control(actor, args, "skip", {
        ...ctx,
        toolCallId: "different-call",
      }),
    ).rejects.toThrow("TASK_VERSION_CONFLICT");
  });
  it("does not consume when the queue rejects admission", async () => {
    const s = await setup();
    const c = await recurring(s, 3);
    await recurringDue(c.task.id);
    vi.spyOn(s.engine, "handleBackground").mockResolvedValue(undefined);
    await s.scheduler.tick();
    const d = await s.tasks.detail(c.task.id);
    expect(d.task.consumed_count).toBe(0);
    expect(d.runs).toHaveLength(0);
    expect(d.task.lifecycle).toBe("active");
  });
  it("pausing during generation suppresses the old result and keeps the recurring rule", async () => {
    const s = await setup();
    const c = await recurring(s, 3);
    vi.spyOn(AgentRunner.prototype, "run").mockImplementation(async () => {
      await s.tasks.control(
        { kind: "admin", id: "fixture" },
        { id: c.task.id, expectedVersion: 1 },
        "pause",
      );
      return success("迟到结果");
    });
    await recurringDue(c.task.id);
    await s.scheduler.tick();
    expect(s.send).not.toHaveBeenCalled();
    expect((await s.tasks.detail(c.task.id)).task.lifecycle).toBe("paused");
  });
  it("cancels future recurrence after the send fence without rewriting the submitted outcome", async () => {
    const s = await setup();
    const c = await recurring(s, 3);
    vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue(success("提醒"));
    s.send.mockImplementation(async () => {
      const t = await s.tasks.change(
        { kind: "admin", id: "fixture" },
        { id: c.task.id, expectedVersion: 1 },
        true,
      );
      expect(t.sendingAlreadyStarted).toBe(true);
      return { status: "confirmed", providerMessageId: "fictional-send" };
    });
    await recurringDue(c.task.id);
    await s.scheduler.tick();
    await s.scheduler.tick();
    const d = await s.tasks.detail(c.task.id);
    expect(d.task.lifecycle).toBe("cancelled");
    expect(d.occurrences[0]?.status).toBe("sent");
    expect(s.send).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "preserves count when editing recurring rules (paused=%s)",
    async (paused) => {
      const s = await setup();
      const c = await recurring(s, 3);
      await s.tasks.control(
        { kind: "admin", id: "fixture" },
        { id: c.task.id, expectedVersion: 1 },
        "skip",
      );
      await expect(
        s.tasks.change(
          { kind: "admin", id: "fixture" },
          {
            id: c.task.id,
            expectedVersion: 2,
            scheduledAt: new Date(Date.now() + 3600000).toISOString(),
          },
          false,
        ),
      ).rejects.toThrow("TASK_LEGACY_UPDATE_UNSUPPORTED");
      if (paused)
        await s.tasks.control(
          { kind: "admin", id: "fixture" },
          { id: c.task.id, expectedVersion: 2 },
          "pause",
        );
      const updated = await s.tasks.change(
        { kind: "admin", id: "fixture" },
        {
          id: c.task.id,
          expectedVersion: paused ? 3 : 2,
          schedule: {
            kind: "recurring",
            startsAt: new Date(Date.now() + 3600000).toISOString(),
            rule: { type: "daily", localTime: "09:00" },
            end: { kind: "count", count: 1 },
          },
        },
        false,
      );
      expect(updated.lifecycle).toBe("completed");
      expect(updated.consumed_count).toBe(1);
    },
  );
  it("global pause and resume skip the paused interval without consuming it", async () => {
    const s = await setup();
    const c = await recurring(s, 3);
    await recurringDue(c.task.id, 181);
    const settings = await s.tasks.settings();
    try {
      await s.tasks.configure({
        paused: true,
        pendingLimit: 1000,
        catchupMinutes: 30,
        expectedVersion: settings.version,
      });
      await s.scheduler.tick();
      expect(s.send).not.toHaveBeenCalled();
      await s.tasks.configure({
        paused: false,
        pendingLimit: 1000,
        catchupMinutes: 30,
        expectedVersion: settings.version + 1,
      });
      await s.scheduler.tick();
      const d = await s.tasks.detail(c.task.id);
      expect(d.task.consumed_count).toBe(0);
      expect(d.task.scheduled_at.getTime()).toBeGreaterThan(Date.now());
      expect(s.send).not.toHaveBeenCalled();
    } finally {
      await pool.query(
        "UPDATE scheduled_task_settings SET paused=false WHERE id=1",
      );
    }
  });
  it("does not restart old slots when pausing and resuming an already submitted send", async () => {
    const s = await setup();
    const c = await recurring(s, 4);
    vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue(success("提醒"));
    s.send.mockImplementation(async () => {
      await s.tasks.control(
        { kind: "admin", id: "fixture" },
        { id: c.task.id, expectedVersion: 1 },
        "pause",
      );
      await s.tasks.control(
        { kind: "admin", id: "fixture" },
        { id: c.task.id, expectedVersion: 2 },
        "resume",
      );
      return { status: "confirmed", providerMessageId: "fictional-send" };
    });
    await recurringDue(c.task.id);
    await s.scheduler.tick();
    await s.scheduler.tick();
    const d = await s.tasks.detail(c.task.id);
    expect(d.task).toMatchObject({
      lifecycle: "active",
      status: "pending",
      consumed_count: 1,
    });
    expect(d.task.scheduled_at.getTime()).toBeGreaterThan(Date.now());
    expect(d.occurrences[0]?.status).toBe("sent");
    expect(s.send).toHaveBeenCalledTimes(1);
  });
  it("prunes old occurrence content even while the recurring definition remains active", async () => {
    const s = await setup();
    const c = await recurring(s, 4);
    vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue(success("提醒"));
    await recurringDue(c.task.id);
    await s.scheduler.tick();
    await pool.query(
      "UPDATE scheduled_task_occurrences SET finished_at=now()-interval '91 days' WHERE task_id=$1 AND status='sent'",
      [c.task.id],
    );
    await pool.query(
      "UPDATE scheduled_task_runs SET finished_at=now()-interval '91 days' WHERE task_id=$1",
      [c.task.id],
    );
    try {
      await pool.query(
        "UPDATE scheduled_task_settings SET retention_days=180 WHERE id=1",
      );
      await s.scheduler.reconcile();
      const retained = await s.tasks.detail(c.task.id);
      expect(retained.runs[0]?.task_snapshot).not.toBeNull();
      expect(retained.occurrences[0]?.snapshot).not.toBeNull();
      await pool.query(
        "UPDATE scheduled_task_settings SET retention_days=30 WHERE id=1",
      );
      await s.scheduler.reconcile();
    } finally {
      await pool.query(
        "UPDATE scheduled_task_settings SET retention_days=30 WHERE id=1",
      );
    }
    const d = await s.tasks.detail(c.task.id);
    expect(d.task.content).toBe("虚构周期提醒");
    expect(d.runs[0]?.task_snapshot).toBeNull();
    expect(d.occurrences[0]?.snapshot).toBeNull();
  });
  it("allows content edits while paused after the old scheduled time", async () => {
    const s = await setup();
    const c = await recurring(s, 3);
    await recurringDue(c.task.id, 181);
    await s.tasks.control(
      { kind: "admin", id: "fixture" },
      { id: c.task.id, expectedVersion: 1 },
      "pause",
    );
    const updated = await s.tasks.change(
      { kind: "admin", id: "fixture" },
      { id: c.task.id, expectedVersion: 2, content: "新的虚构提醒内容" },
      false,
    );
    expect(updated).toMatchObject({
      lifecycle: "paused",
      consumed_count: 0,
      content: "新的虚构提醒内容",
    });
  });
  it("closes an interrupted unsent execution when paused rather than leaving it running forever", async () => {
    const s = await setup();
    const c = await recurring(s, 3);
    await recurringDue(c.task.id);
    const claim = vi
      .spyOn(s.engine, "handleBackground")
      .mockImplementationOnce(async (input) => {
        await input.accept();
        throw new Error("fixture crash");
      });
    await expect(s.scheduler.tick()).rejects.toThrow();
    claim.mockRestore();
    const before = (await s.tasks.detail(c.task.id)).runs[0]!;
    await s.tasks.control(
      { kind: "admin", id: "fixture" },
      { id: c.task.id, expectedVersion: 1 },
      "pause",
    );
    expect(
      (await repository.getExecution(String(before.execution_id)))?.status,
    ).toBe("skipped");
    expect(s.send).not.toHaveBeenCalled();
  });
});
