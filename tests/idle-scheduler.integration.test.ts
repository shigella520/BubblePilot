import {
  ConversationContextService,
  type ConversationContextSnapshot,
} from "../modules/workflow/conversation-context-service.js";
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
import { IdleScheduler } from "../modules/workflow/idle-scheduler.js";
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
describe.runIf(!!url)("idle scheduling with PostgreSQL", () => {
  let pool: Pool,
    repository: PostgresWorkflowRepository,
    archive: PostgresArchiveRepository;
  const workflowIds: string[] = [];
  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    repository = new PostgresWorkflowRepository(url!);
    archive = new PostgresArchiveRepository(url!);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
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
    dailyLimit = 2,
  ) {
    const chatId = `fictional-idle-${randomUUID()}`;
    let now = new Date(Date.now() + 60_000);
    const config = {
      enabled: true,
      chatIds: [chatId],
      timeZone: "UTC",
      idleMinutes: 10,
      dailyLimit,
      quietPeriods: [],
    };
    const definition = parseWorkflowDefinition({
      schemaVersion: "1",
      name: chatId,
      startNodeId: "message-trigger",
      nodes: [
        {
          id: "message-trigger",
          type: "message-trigger",
          version: 1,
          config: { enabled: false, idle: config },
          onSuccess: "ai",
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
            includeLoadedContext: false,
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
    const engine = new WorkflowEngine(
      repository,
      createDefaultNodeRegistry(
        repository,
        { sendReply: send },
        { archive, aiRouting: routing },
      ),
    );
    const scheduler = new IdleScheduler(
      pool,
      repository,
      engine,
      "UTC",
      () => now,
    );
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
      send,
      message,
      advance,
      engine,
      version,
      trigger,
      chatId,
    };
  }
  it("only selected chats run once, uses no fake current message, and consumes skip eligibility", async () => {
    const s = await setup();
    const run = vi
      .spyOn(AgentRunner.prototype, "run")
      .mockResolvedValue(success('{"action":"skip","reason":"repetitive"}'));
    await s.message();
    s.advance(11);
    await s.scheduler.tick();
    await s.scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.send).not.toHaveBeenCalled();
    const history = await s.scheduler.history(s.version.workflowId, {
      limit: 1,
    });
    expect(history.items[0]).toMatchObject({
      reason: "idle-model-skip",
      skipReason: "repetitive",
      status: "skipped",
    });
    expect(
      (await s.scheduler.preview(s.version.workflowId))[0]?.earliestTriggerAt,
    ).toBeNull();
    expect(
      (
        await s.scheduler.history(s.version.workflowId, {
          chatId: "fictional-other",
        })
      ).items,
    ).toEqual([]);
    const request = run.mock.calls[0]![0];
    expect(request.idleDecision).toBe(true);
    expect(JSON.stringify(request.messages)).toContain("没有新的用户消息");
    expect(JSON.stringify(request.messages)).not.toContain("<current_message>");
    const rows = await pool.query(
      "SELECT e.status,e.source_message_id,e.trigger_event FROM workflow_executions e JOIN workflow_versions v ON v.id=e.workflow_version_id WHERE v.workflow_id=$1",
      [s.version.workflowId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      status: "skipped",
      source_message_id: null,
      trigger_event: { message: null },
    });
    await s.message();
    s.advance(11);
    await s.scheduler.tick();
    expect(run).toHaveBeenCalledTimes(2);
    const first = await s.scheduler.history(s.version.workflowId, { limit: 1 });
    const second = await s.scheduler.history(s.version.workflowId, {
      limit: 1,
      offset: 1,
    });
    expect(
      (await s.scheduler.history(s.version.workflowId, { chatId: s.chatId }))
        .items,
    ).toHaveLength(2);
    expect(
      (
        await s.scheduler.history(s.version.workflowId, {
          chatId: "missing-fictional-chat",
        })
      ).items,
    ).toEqual([]);
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
    expect(
      (await s.scheduler.history(s.version.workflowId, { status: "succeeded" }))
        .items,
    ).toEqual([]);
    expect((await s.scheduler.history(randomUUID())).items).toEqual([]);
  });
  it("sends only the decision text and reserves workflow daily quota", async () => {
    const s = await setup();
    const run = vi
      .spyOn(AgentRunner.prototype, "run")
      .mockResolvedValue(success('{"action":"send","text":"虚构问候"}'));
    for (let i = 0; i < 3; i++) {
      await s.message();
      s.advance(11);
      await s.scheduler.tick();
    }
    expect(s.send).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(s.send.mock.calls[0]).toBeDefined();
    const rows = await pool.query(
      "SELECT a.state FROM idle_attempts a JOIN workflow_versions v ON v.id=a.workflow_version_id WHERE v.workflow_id=$1 ORDER BY a.created_at",
      [s.version.workflowId],
    );
    expect(rows.rows.map((r: { state: string }) => r.state)).toEqual([
      "confirmed",
      "confirmed",
      "released",
    ]);
  });
  it("allows more than the retired instance limit and reports only workflow quota", async () => {
    const s = await setup(undefined, 3);
    vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue(
      success('{"action":"send","text":"虚构问候"}'),
    );
    for (let i = 0; i < 4; i++) {
      await s.message();
      s.advance(11);
      await s.scheduler.tick();
    }
    expect(s.send).toHaveBeenCalledTimes(3);
    const preview = await s.scheduler.preview(s.version.workflowId);
    expect(preview[0]?.workflowRemaining).toBe(0);
    expect(preview[0]).not.toHaveProperty("instanceRemaining");
  });
  it("cancels when a human speaks during generation", async () => {
    const s = await setup();
    vi.spyOn(AgentRunner.prototype, "run").mockImplementation(async () => {
      await s.message();
      return success('{"action":"send","text":"过时问候"}');
    });
    await s.message();
    s.advance(11);
    await s.scheduler.tick();
    expect(s.send).not.toHaveBeenCalled();
  });
  it("rejects invalid decisions and ignores replay and old messages", async () => {
    const s = await setup();
    const run = vi
      .spyOn(AgentRunner.prototype, "run")
      .mockResolvedValue(success("无需回复"));
    await s.message({ replay: true });
    s.advance(11);
    await s.scheduler.tick();
    expect(run).not.toHaveBeenCalled();
    await s.message();
    s.advance(11);
    await s.scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.send).not.toHaveBeenCalled();
    await s.message({ offset: -60 * 60_000 });
    await s.scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("does not resend unknown delivery and does not count self messages as new human eligibility", async () => {
    const s = await setup({
      status: "unknown",
      code: "FICTIONAL_TIMEOUT",
      summary: "Fictional timeout",
    });
    const run = vi
      .spyOn(AgentRunner.prototype, "run")
      .mockResolvedValue(success('{"action":"send","text":"虚构问候"}'));
    await s.message();
    s.advance(11);
    await s.scheduler.tick();
    await s.message({ isFromMe: true });
    s.advance(11);
    await s.scheduler.tick();
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("serializes two scheduler instances", async () => {
    const s = await setup();
    const run = vi
      .spyOn(AgentRunner.prototype, "run")
      .mockResolvedValue(success('{"action":"send","text":"虚构问候"}'));
    await s.message();
    s.advance(11);
    await Promise.all([s.scheduler.tick(), s.scheduler.tick()]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledTimes(1);
  });
  it("recovers the same execution after interruption without colliding node attempts", async () => {
    const s = await setup();
    const run = vi
      .spyOn(AgentRunner.prototype, "run")
      .mockResolvedValue(success('{"action":"skip"}'));
    await s.message();
    s.advance(11);
    await s.scheduler.tick();
    const row = (
      await pool.query<{ id: string }>(
        "SELECT e.id FROM workflow_executions e JOIN workflow_versions v ON v.id=e.workflow_version_id WHERE v.workflow_id=$1",
        [s.version.workflowId],
      )
    ).rows[0]!;
    await pool.query(
      "UPDATE workflow_executions SET status='running',completed_at=NULL WHERE id=$1",
      [row.id],
    );
    await pool.query(
      "UPDATE idle_attempts SET state='accepted' WHERE execution_id=$1",
      [row.id],
    );
    await s.scheduler.tick();
    expect(run).toHaveBeenCalledTimes(2);
    const detail = await repository.getExecution(row.id);
    expect(detail?.status).toBe("skipped");
    expect(detail?.recoveryAttempt).toBe(1);
    expect(
      detail?.nodes
        .filter((node) => node.nodeId === "ai")
        .map((node) => node.attempt),
    ).toEqual([1, 2]);
  });
  it("locks historical context at acceptance without moving the message window", async () => {
    const s = await setup();
    vi.spyOn(AgentRunner.prototype, "run").mockResolvedValue(
      success('{"action":"skip"}'),
    );
    const first = await s.message();
    s.advance(11);
    await s.scheduler.tick();
    const row = (
      await pool.query<{
        id: string;
        context_snapshot: ConversationContextSnapshot;
      }>(
        "SELECT e.id,e.context_snapshot FROM workflow_executions e JOIN workflow_versions v ON v.id=e.workflow_version_id WHERE v.workflow_id=$1",
        [s.version.workflowId],
      )
    ).rows[0]!;
    await s.message();
    const context = new ConversationContextService(url!);
    try {
      const loaded = await context.load({
        executionId: row.id,
        idleExecutionId: row.id,
        provider: "bluebubbles",
        providerChatId: s.chatId,
        beforeProviderMessageId: "",
        settings: row.context_snapshot.settings,
        settingsVersion: row.context_snapshot.settingsVersion,
        contextSnapshot: row.context_snapshot,
      });
      expect(
        loaded.messages.map((message) => message.providerMessageId),
      ).toEqual([first.message.providerMessageId]);
      const windows = await pool.query(
        "SELECT 1 FROM conversation_context_windows WHERE chat_id=$1",
        [row.context_snapshot.chatId],
      );
      expect(windows.rowCount).toBe(0);
    } finally {
      await context.close();
    }
  });
  it("cancels after workflow revocation and source cleanup", async () => {
    const s = await setup();
    vi.spyOn(AgentRunner.prototype, "run").mockImplementation(async () => {
      await repository.setWorkflowEnabled(s.version.workflowId, false);
      return success('{"action":"send","text":"must not send"}');
    });
    await s.message();
    s.advance(11);
    await s.scheduler.tick();
    expect(s.send).not.toHaveBeenCalled();
    const s2 = await setup();
    await s2.message();
    s2.advance(11);
    await pool.query(
      "UPDATE messages SET content_redacted_at=now(),body=NULL WHERE chat_id=(SELECT id FROM chats WHERE provider_chat_id=$1)",
      [s2.chatId],
    );
    await s2.scheduler.tick();
    expect(s2.send).not.toHaveBeenCalled();
  });
  it("lets only one workflow consume a shared chat activity cycle", async () => {
    const s = await setup();
    const version = await repository.createWorkflow(
      "Fictional competing role",
      s.version.definition,
    );
    workflowIds.push(version.workflowId);
    await repository.publishWorkflowVersion(version.workflowId, 1);
    await repository.createTrigger({
      name: "Fictional second trigger",
      workflowId: version.workflowId,
      workflowVersion: 1,
      conditions: parseTriggerConditions({ chatIds: [s.chatId] }),
      includeFromMe: false,
      enabled: true,
    });
    const run = vi
      .spyOn(AgentRunner.prototype, "run")
      .mockResolvedValue(success('{"action":"send","text":"唯一问候"}'));
    await s.message();
    s.advance(11);
    await s.scheduler.tick();
    await s.scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledTimes(1);
  });
  it("does not consume eligibility when the execution gate refuses admission", async () => {
    const s = await setup();
    const run = vi
      .spyOn(AgentRunner.prototype, "run")
      .mockResolvedValue(success('{"action":"skip"}'));
    await s.message();
    s.advance(11);
    const admission = vi
      .spyOn(s.engine, "handleIdle")
      .mockRejectedValueOnce(new Error("Fictional queue full"));
    await s.scheduler.tick();
    admission.mockRestore();
    expect(run).not.toHaveBeenCalled();
    const state = (
      await pool.query<{ generation: string; consumed_generation: string }>(
        "SELECT generation,consumed_generation FROM idle_chat_activity WHERE chat_id=(SELECT id FROM chats WHERE provider_chat_id=$1)",
        [s.chatId],
      )
    ).rows[0]!;
    expect(BigInt(state.consumed_generation)).toBeLessThan(
      BigInt(state.generation),
    );
    await s.scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
