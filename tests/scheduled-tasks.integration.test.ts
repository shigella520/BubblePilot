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
          config: { enabled: true, scheduled: config },
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
          },
          onSuccess: "reply",
        },
        {
          id: "reply",
          type: "reply",
          version: 1,
          config: { text: "{{variables.reply}}" },
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
  it("persists once, scopes tools, and rejects other members", async () => {
    const s = await setup();
    const c = await create(s);
    const again = await s.tasks.create(c.executionId, c.input, c.ctx);
    expect(again.id).toBe(c.task.id);
    expect(await s.tasks.tools(c.executionId)).toHaveLength(4);
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
    const s = await setup(undefined, true);
    const c = await create(s);
    const model = vi
      .spyOn(AgentRunner.prototype, "run")
      .mockResolvedValue(success("五点到了，请记得抢票！"));
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
  it("recovers the same logical execution after an interrupted claim", async () => {
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
  });
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
    expect(execute.mock.calls[0]![0].tools).toHaveLength(4);
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
});
