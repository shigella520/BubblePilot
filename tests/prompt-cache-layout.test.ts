import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../modules/ai/agent-runner.js";
import { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import {
  OpenAiCompatibleClient,
  type AiClient,
} from "../modules/ai/openai-compatible-client.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import type { AiChatRequest, AiApiKind } from "../modules/ai/ai-types.js";
import type { ContextMessage } from "../modules/archive/archive-repository.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import { emptyLinkPreview } from "../modules/ingestion/link-preview.js";
import { parsePluginPackage } from "../modules/plugins/plugin-package.js";
import type { PluginService } from "../modules/plugins/plugin-service.js";
import type { InstalledPlugin } from "../modules/plugins/plugin-types.js";
import type { TaskService } from "../modules/scheduled-tasks/task-service.js";
import {
  createDefaultNodeRegistry,
  type NodeExecutionContext,
} from "../modules/workflow/node-registry.js";
import type { WorkflowNode } from "../modules/workflow/workflow-definition.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";
import { InMemoryArchiveRepository } from "./support/in-memory-archive-repository.js";
import { InMemoryWorkflowRepository } from "./support/in-memory-workflow-repository.js";

const workflowId = "11111111-1111-4111-8111-111111111111";
const pluginIds = [
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const memberA = {
  senderId: "a@example.test",
  realName: "虚构甲",
  nickname: "甲",
};
const memberB = {
  senderId: "b@example.test",
  realName: "虚构乙",
  nickname: "乙",
};
function history(id: string, body: string, bot = false): ContextMessage {
  return {
    providerMessageId: id,
    senderId: bot ? null : memberA.senderId,
    body,
    sentAt: "2026-11-01T01:00:00.000Z",
    isFromMe: bot,
    ...(bot
      ? {
          author: {
            kind: "bot" as const,
            workflowId,
            nickname: "虚构助手",
            version: 1,
            basis: "send-snapshot" as const,
            revision: 1,
          },
        }
      : {}),
    attachments: [],
    linkPreview: emptyLinkPreview(),
  };
}
function context(turn = 0): NodeExecutionContext {
  const event = new BlueBubblesWebhookAdapter().normalize(
    newMessageWebhook({
      messageGuid: `fictional-turn-${turn}`,
      text: `虚构问题 ${turn}`,
      senderAddress: memberA.senderId,
    }),
    randomUUID(),
  );
  if (event.kind !== "message") throw new Error("fixture");
  return {
    executionId: randomUUID(),
    workflowId,
    correlationId: randomUUID(),
    timeZone: "Asia/Shanghai",
    envelope: event.envelope,
    variables: { style: "简洁" },
    history: [history("old", "Stable fictional history")],
    participantIdentities: { a: memberA, b: memberB },
    outputs: {},
    contextSnapshot: null,
    botIdentity: { workflowId, nickname: "虚构助手", version: 1 },
  };
}
function backgroundContext(
  mode: "idle" | "scheduled-v1" | "scheduled-v2",
  turn: number,
): NodeExecutionContext {
  const ctx = context(turn);
  const base = {
    eventId: `fixture-${mode}-${turn}`,
    correlationId: ctx.correlationId,
    provider: "bluebubbles" as const,
    chat: ctx.envelope.chat,
    message: null,
  };
  ctx.envelope =
    mode === "idle"
      ? {
          ...base,
          schemaVersion: "chat-idle-v1",
          idle: {
            chatId: "fixture-chat",
            activityGeneration: String(turn),
            lastActivityAt: "2026-11-01T00:00:00Z",
            lastMessageIndex: String(turn),
            upperMessageIndex: String(turn + 1),
            triggeredAt: "2026-11-01T01:00:00Z",
            workflowVersionId: "fixture-version",
            taskInstruction: "虚构主动交流任务",
          },
        }
      : {
          ...base,
          schemaVersion:
            mode === "scheduled-v1" ? "scheduled-task-v1" : "scheduled-task-v2",
          scheduled: {
            taskId: `fixture-task-${turn}`,
            taskVersion: turn,
            chatId: "fixture-chat",
            content: "虚构提醒任务",
            requestSnapshot: "虚构原始请求",
            creatorSenderId: memberA.senderId,
            scheduledAt: "2026-11-01T01:00:00Z",
            triggeredAt: "2026-11-01T01:00:00Z",
            timeZone: "Asia/Shanghai",
            upperMessageIndex: String(turn + 1),
            workflowVersionId: "fixture-version",
          },
        };
  return ctx;
}
const messageText = (request: AiChatRequest) =>
  request.messages
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
const firstHistory = (request: AiChatRequest) =>
  request.messages.findIndex(
    (m) => typeof m.content === "string" && m.content.includes("<chat_history"),
  );
// Model the documented gateway behavior using actual encoded payloads:
// hoist every system/developer message, regardless of its original position.
function gatewaySystem(payload: Record<string, unknown>): string {
  const items = (payload.messages ?? payload.input) as Array<{
    role?: string;
    content: string | Array<{ text?: string }>;
  }>;
  return items
    .filter((item) => item.role === "system" || item.role === "developer")
    .map((item) =>
      typeof item.content === "string"
        ? item.content
        : item.content.map((part) => part.text ?? "").join("\n"),
    )
    .join("\n\n");
}
function sharedPrefix(a: string, b: string): string {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  return a.slice(0, i);
}

async function setup(apiKind: AiApiKind, useTool = false, answer = "虚构回答") {
  const repo = new InMemoryAiRepository();
  const provider = await repo.createProvider({
    name: "Fictional",
    apiKind,
    baseUrl: "https://ai.example.test/v1",
    model: "fixture",
    secretRef: "TEST_KEY",
    parameters: {},
    requestTimeoutMs: 5000,
    enabled: true,
    capabilities: { functionCalling: true, hostedWebSearch: false },
    sessionAffinity: "session-id-header",
  });
  if (provider.status !== "ok") throw new Error("fixture");
  await repo.updateProviderCapabilityProbe(provider.value.id, {
    functionCalling: "verified",
    hostedWebSearch: "unknown",
    checkedAt: new Date(0).toISOString(),
  });
  const route = await repo.createRoute({
    name: "Fixture",
    providerIds: [provider.value.id],
    fallbackEnabled: false,
    retryPolicy: { maxRounds: 1, initialDelayMs: 0 },
    degradePolicy: { failureThreshold: 3, cooldownMs: 60000 },
    enabled: true,
  });
  if (route.status !== "ok") throw new Error("fixture");
  const plugins: InstalledPlugin[] = pluginIds.map((id, i) => {
    const pkg = parsePluginPackage(
      {
        "plugin.json": JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: `fictional-${i}`,
          version: "1.0.0",
          description: "Fictional plugin",
        }),
        "skills/demo/SKILL.md":
          "---\nname: demo\ndescription: Fictional skill directory\n---\nFictional skill body.",
      },
      ".",
    );
    return {
      id,
      name: pkg.name,
      version: 1,
      revision: pkg.hash,
      enabled: true,
      package: pkg,
      config: {
        connections: {},
        tools: [],
        disabledSkills: [],
        disabledTools: [],
      },
    };
  });
  const service = {
    assertAvailable: async () => {},
    get: (id: string) => Promise.resolve(plugins.find((p) => p.id === id)!),
  } as unknown as PluginService;
  const requests: AiChatRequest[] = [];
  const payloads: Record<string, unknown>[] = [];
  const sessionIds: (string | null)[] = [];
  const secrets = new EnvironmentSecretResolver({
    TEST_KEY: "fictional-secret",
  });
  const wire = new OpenAiCompatibleClient(secrets, (_url, init) => {
    const payload = JSON.parse(
      typeof init?.body === "string" ? init.body : "null",
    ) as Record<string, unknown>;
    payloads.push(payload);
    sessionIds.push(new Headers(init?.headers).get("X-Session-ID"));
    const done =
      !useTool || JSON.stringify(payload).includes("fictional_tool_result");
    const call = {
      id: "fixture-call",
      type: "function",
      function: { name: "list_scheduled_tasks", arguments: "{}" },
    };
    return Promise.resolve(
      new Response(
        JSON.stringify(
          apiKind === "responses"
            ? done
              ? { output_text: answer }
              : {
                  output: [
                    {
                      type: "function_call",
                      call_id: call.id,
                      name: call.function.name,
                      arguments: "{}",
                    },
                  ],
                }
            : {
                choices: [
                  {
                    message: done
                      ? { role: "assistant", content: answer }
                      : {
                          role: "assistant",
                          content: null,
                          tool_calls: [call],
                        },
                    finish_reason: done ? "stop" : "tool_calls",
                  },
                ],
              },
        ),
        { headers: { "content-type": "application/json" } },
      ),
    );
  });
  const client: AiClient = {
    call: (p, r) => {
      requests.push(structuredClone(r));
      return wire.call(p, r);
    },
  };
  const routing = new AiRoutingService(repo, client, secrets, true);
  let reverse = false;
  const tasks = {
    pool: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
    tools: () => {
      const tools = ["list_scheduled_tasks", "create_scheduled_task"].map(
        (name) => ({
          definition: {
            name,
            description: "Fictional task tool",
            parameters: reverse
              ? {
                  additionalProperties: false,
                  properties: {
                    status: { enum: ["pending", "sent"], type: "string" },
                    limit: { maximum: 10, type: "integer" },
                  },
                  type: "object",
                }
              : {
                  type: "object",
                  properties: {
                    limit: { type: "integer", maximum: 10 },
                    status: { type: "string", enum: ["pending", "sent"] },
                  },
                  additionalProperties: false,
                },
          },
          diagnostics: "metadata-only" as const,
          execute: () => Promise.resolve('{"fictional_tool_result":true}'),
        }),
      );
      return Promise.resolve(reverse ? tools.reverse() : tools);
    },
  } as unknown as TaskService;
  const runner = new AgentRunner(
    routing,
    undefined,
    repo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    service,
  );
  const registry = createDefaultNodeRegistry(
    new InMemoryWorkflowRepository(),
    {
      sendReply: () => Promise.reject(new Error("Must not send")),
    },
    {
      archive: new InMemoryArchiveRepository(),
      aiRouting: routing,
      aiAgent: runner,
      tasks,
    },
  );
  const node: Extract<WorkflowNode, { type: "ai-chat" }> = {
    id: "ai",
    type: "ai-chat",
    version: 1,
    config: {
      providerRouteId: route.value.id,
      systemPrompt: "Stable fictional persona.",
      promptTemplate: "Answer the current task.",
      includeLoadedContext: true,
      maxOutputTokens: 256,
      maxOutputCharacters: 2000,
      temperature: 0,
      outputFormat: "text",
      outputVariable: "answer",
      webSearchSources: "full",
      pluginIds,
    },
    inputs: { prompt: { kind: "path", path: "context.event.message.text" } },
    onSuccess: "done",
    onFailure: "done",
  };
  return {
    repo,
    providerId: provider.value.id,
    requests,
    payloads,
    sessionIds,
    node,
    plugins,
    reverse: () => {
      reverse = !reverse;
    },
    run: async (ctx: NodeExecutionContext) => {
      const result = await registry.resolve(node).execute(node, ctx);
      expect(result.status).toBe("succeeded");
    },
  };
}

afterEach(() => vi.useRealTimers());
describe.each(["chat-completions", "responses"] as const)(
  "cache-oriented request assembly: %s",
  (apiKind) => {
    it("preserves configuration and existing history across three daily chat turns on the wire", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const f = await setup(apiKind);
      const transcript = context().history;
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(new Date(`2026-11-0${i + 1}T03:00:00Z`));
        const ctx = context(i);
        ctx.history = [...transcript];
        if (i % 2) ctx.participantIdentities = { b: memberB, a: memberA };
        f.node.config.pluginIds = i % 2 ? [...pluginIds].reverse() : pluginIds;
        f.reverse();
        await f.run(ctx);
        transcript.push(
          history(`user-${i}`, `虚构问题 ${i}`),
          history(`bot-${i}`, `虚构回答 ${i}`, true),
        );
      }
      expect(f.requests).toHaveLength(3);
      const first = f.requests[0]!;
      const configPrefix = first.messages.slice(0, firstHistory(first));
      expect(JSON.stringify(configPrefix)).toContain("participant_identities");
      expect(JSON.stringify(configPrefix)).toContain("Available plugin skills");
      expect(JSON.stringify(configPrefix)).not.toContain("当前服务端时间");
      for (let i = 0; i < 3; i++) {
        const r = f.requests[i]!;
        expect(r.messages.slice(0, firstHistory(r))).toEqual(configPrefix);
        const text = messageText(r);
        expect(text.indexOf("<agent_budget_status>")).toBeGreaterThan(
          text.indexOf("Stable fictional history"),
        );
        expect(text).toContain(`2026-11-0${i + 1}T03:00:00.000Z`);
        expect(r.messages.at(-1)!.role).toBe("user");
        expect(gatewaySystem(f.payloads[i]!)).toBe(
          gatewaySystem(f.payloads[0]!),
        );
        expect(gatewaySystem(f.payloads[i]!)).not.toContain("2026-11-0");
        expect(f.payloads[i]!.tools).toEqual(f.payloads[0]!.tools);
        expect(f.sessionIds[i]).toBe(f.sessionIds[0]);
        expect(JSON.stringify(f.payloads[i])).not.toContain(
          "configurationMessageCount",
        );
        if (apiKind === "responses")
          expect(f.payloads[i]!.prompt_cache_key).toBe(f.sessionIds[0]);
        if (i > 0) {
          const key = apiKind === "responses" ? "input" : "messages";
          const prefix = sharedPrefix(
            JSON.stringify(f.payloads[i - 1]![key]),
            JSON.stringify(f.payloads[i]![key]),
          );
          expect(prefix).toContain("Stable fictional history");
          expect(prefix).toContain("Fictional skill directory");
          for (const message of f.requests[i - 1]!.messages.filter(
            (m) => m.traceMessageId !== undefined,
          )) {
            // Every previously supplied history block survives byte-for-byte,
            // even when adjacent user blocks are merged by the wire encoder.
            expect(prefix).toContain(
              JSON.stringify(message.content).slice(1, -1),
            );
          }
        }
      }
    });

    it("separates message and scheduled sessions and compares each mode to its own prior request", async () => {
      const f = await setup(
        apiKind,
        false,
        '{"action":"send","text":"虚构主动交流"}',
      );
      const first = context(1);
      const sequence = [
        first,
        backgroundContext("idle", 2),
        context(3),
        context(4),
        context(5),
        backgroundContext("scheduled-v2", 6),
        context(7),
        backgroundContext("scheduled-v1", 8),
      ];
      for (const ctx of sequence) await f.run(ctx);

      const digest = (value: string) =>
        `sha256:${createHash("sha256").update(value).digest("hex")}`;
      const oldScope = digest(
        [
          first.envelope.provider,
          first.envelope.chat.providerChatId,
          first.workflowId,
          f.node.id,
        ].join("\u0000"),
      );
      const oldSession = `bp_${digest(`${f.providerId}\u0000${oldScope}`).slice("sha256:".length)}`;
      expect(f.sessionIds[0]).toBe(oldSession);
      const messageSession = f.sessionIds[0];
      const backgroundSession = f.sessionIds[1];
      const scheduledScope = digest(
        [
          first.envelope.provider,
          first.envelope.chat.providerChatId,
          first.workflowId,
          f.node.id,
          "scheduled",
        ].join("\u0000"),
      );
      const scheduledSession = `bp_${digest(`${f.providerId}\u0000${scheduledScope}`).slice("sha256:".length)}`;
      expect(backgroundSession).toBe(scheduledSession);
      expect(backgroundSession).toMatch(/^bp_[a-f0-9]{64}$/u);
      expect(backgroundSession).not.toBe(messageSession);
      for (const i of [2, 3, 4, 6])
        expect(f.sessionIds[i]).toBe(messageSession);
      for (const i of [5, 7]) expect(f.sessionIds[i]).toBe(backgroundSession);
      for (const [i, payload] of f.payloads.entries()) {
        if (apiKind === "responses")
          expect(payload.prompt_cache_key).toBe(f.sessionIds[i]);
        else expect(payload).not.toHaveProperty("prompt_cache_key");
      }

      const traces = f.repo.attempts.map(
        (attempt) => attempt.diagnostics?.requestTrace,
      );
      expect(traces).toHaveLength(sequence.length);
      expect(traces[0]?.previousRequestHash).toBeNull();
      expect(traces[1]?.previousRequestHash).toBeNull();
      for (const [current, previous] of [
        [2, 0],
        [3, 2],
        [4, 3],
        [5, 1],
        [6, 4],
        [7, 5],
      ]) {
        expect(traces[current!]?.previousRequestHash).toBe(
          traces[previous!]?.requestHash,
        );
        expect(traces[current!]?.cacheKeyMatchesPrevious).toBe(true);
      }
    });

    it("keeps the existing chat, workflow, node and Provider isolation for scheduled sessions", async () => {
      const f = await setup(apiKind, false, "虚构提醒");
      const original = backgroundContext("scheduled-v2", 1);
      await f.run(original);

      const otherChat = backgroundContext("scheduled-v2", 2);
      otherChat.envelope.chat.providerChatId = "fictional-other-chat";
      await f.run(otherChat);

      const otherWorkflow = backgroundContext("scheduled-v2", 3);
      otherWorkflow.workflowId = "44444444-4444-4444-8444-444444444444";
      await f.run(otherWorkflow);

      f.node.id = "fictional-other-node";
      await f.run(backgroundContext("scheduled-v2", 4));

      const otherProvider = await setup(apiKind, false, "虚构提醒");
      await otherProvider.run(backgroundContext("scheduled-v2", 5));
      expect(new Set([...f.sessionIds, ...otherProvider.sessionIds]).size).toBe(
        5,
      );
    });

    it("does not send session identifiers when Provider affinity is disabled", async () => {
      const f = await setup(
        apiKind,
        false,
        '{"action":"send","text":"虚构主动交流"}',
      );
      f.repo.providers.get(f.providerId)!.sessionAffinity = "disabled";
      await f.run(context());
      await f.run(backgroundContext("idle", 1));
      expect(f.sessionIds).toEqual([null, null]);
      for (const payload of f.payloads)
        expect(payload).not.toHaveProperty("prompt_cache_key");
      expect(
        f.repo.attempts[1]?.diagnostics?.requestTrace?.previousRequestHash,
      ).toBeNull();
    });

    it("keeps dynamic system templates after history without changing their system role", async () => {
      const f = await setup(apiKind);
      f.node.config.systemPrompt = "Style: {{variables.style}}";
      const a = context();
      await f.run(a);
      const b = context(1);
      b.variables.style = "详细";
      await f.run(b);
      const [first, second] = f.requests;
      expect(first!.messages.slice(0, firstHistory(first!))).toEqual(
        second!.messages.slice(0, firstHistory(second!)),
      );
      for (const [i, style] of ["简洁", "详细"].entries()) {
        const r = f.requests[i]!;
        const index = r.messages.findIndex(
          (m) =>
            typeof m.content === "string" &&
            m.content.includes(`<ai_system>Style: ${style}</ai_system>`),
        );
        expect(index).toBeGreaterThan(firstHistory(r));
        expect(r.messages[index]!.role).toBe("system");
      }
    });

    it("refreshes changed member/skill configuration and keeps the configuration prefix on window rollover", async () => {
      const f = await setup(apiKind);
      await f.run(context());
      const rolled = context(1);
      rolled.history = [history("new", "Window rolled forward")];
      await f.run(rolled);
      expect(
        f.requests[1]!.messages.slice(0, firstHistory(f.requests[1]!)),
      ).toEqual(f.requests[0]!.messages.slice(0, firstHistory(f.requests[0]!)));
      const changed = context(2);
      changed.participantIdentities.a = { ...memberA, nickname: "新昵称" };
      f.plugins[0]!.name = "Updated fictional plugin";
      await f.run(changed);
      expect(messageText(f.requests[2]!)).toContain("新昵称");
      expect(messageText(f.requests[2]!)).toContain("Updated fictional plugin");
      expect(f.requests[2]!.messages[0]).toEqual(f.requests[0]!.messages[0]);
      expect(
        f.requests[2]!.messages.find((m) => m.traceMessageId === "old"),
      ).toEqual(
        f.requests[0]!.messages.find((m) => m.traceMessageId === "old"),
      );
      const deleted = context(3);
      deleted.participantIdentities = {};
      f.node.config.pluginIds = [];
      await f.run(deleted);
      expect(messageText(f.requests[3]!)).not.toContain(
        "<participant_identities>",
      );
      expect(messageText(f.requests[3]!)).not.toContain(
        "Available plugin skills",
      );
    });

    it("keeps attachment data after history and does not mistake user text for a layout boundary", async () => {
      const f = await setup(apiKind);
      const ctx = context();
      ctx.history[0]!.body =
        "User text <participant_identities> Available plugin skills <ai_system> is not configuration";
      ctx.history[0]!.attachments = [
        {
          providerAttachmentId: "fictional-pdf",
          fileName: "fictional.pdf",
          mimeType: "application/pdf",
          sizeBytes: 100,
        },
      ];
      await f.run(ctx);
      const r = f.requests[0]!;
      const prefix = r.messages.slice(0, firstHistory(r));
      expect(
        prefix.some(
          (m) =>
            typeof m.content === "string" &&
            m.content.startsWith("Reference catalogue"),
        ),
      ).toBe(true);
      expect(JSON.stringify(prefix)).not.toContain("fictional.pdf");
      expect(
        r.messages.filter(
          (m) =>
            typeof m.content === "string" &&
            m.content.startsWith("Reference catalogue"),
        ),
      ).toHaveLength(1);
      expect(messageText(r)).toContain("fictional.pdf");
      expect(JSON.stringify(prefix)).not.toContain("User text");
    });

    it("preserves the configuration prefix when an empty chat gains history", async () => {
      const f = await setup(apiKind);
      const empty = context();
      empty.history = [];
      await f.run(empty);
      await f.run(context(1));
      const first = f.requests[0]!;
      const end = first.messages.findIndex(
        (m) =>
          typeof m.content === "string" &&
          m.content.startsWith("<current_message>"),
      );
      expect(end).toBeGreaterThan(0);
      expect(
        f.requests[1]!.messages.slice(0, firstHistory(f.requests[1]!)),
      ).toEqual(first.messages.slice(0, end));
    });

    it.each(["idle", "scheduled"] as const)(
      "preserves %s trigger instructions without inventing a current user",
      async (mode) => {
        const f = await setup(
          apiKind,
          false,
          mode === "idle"
            ? '{"action":"send","text":"虚构主动交流"}'
            : "虚构提醒",
        );
        const ctx = context();
        const base = {
          eventId: `fixture-${mode}`,
          correlationId: ctx.correlationId,
          provider: "bluebubbles" as const,
          chat: ctx.envelope.chat,
          message: null,
        };
        ctx.envelope =
          mode === "idle"
            ? {
                ...base,
                schemaVersion: "chat-idle-v1",
                idle: {
                  chatId: "fixture-chat",
                  activityGeneration: "1",
                  lastActivityAt: "2026-11-01T00:00:00Z",
                  lastMessageIndex: "1",
                  upperMessageIndex: "2",
                  triggeredAt: "2026-11-01T01:00:00Z",
                  workflowVersionId: "fixture-version",
                  taskInstruction: "虚构主动交流任务",
                },
              }
            : {
                ...base,
                schemaVersion: "scheduled-task-v2",
                scheduled: {
                  taskId: "fixture-task",
                  taskVersion: 1,
                  chatId: "fixture-chat",
                  content: "虚构提醒任务",
                  requestSnapshot: "虚构原始请求",
                  creatorSenderId: memberA.senderId,
                  scheduledAt: "2026-11-01T01:00:00Z",
                  triggeredAt: "2026-11-01T01:00:00Z",
                  timeZone: "Asia/Shanghai",
                  upperMessageIndex: "2",
                  workflowVersionId: "fixture-version",
                },
              };
        await f.run(ctx);
        const r = f.requests[0]!;
        expect(
          r.messages.some(
            (m) =>
              typeof m.content === "string" &&
              m.content.startsWith("<current_message>"),
          ),
        ).toBe(false);
        expect(messageText(r)).not.toContain('"currentTime"');
        expect(messageText(r)).toContain(
          mode === "idle" ? "虚构主动交流任务" : "虚构提醒任务",
        );
        expect(
          r.messages
            .slice(firstHistory(r) + 1)
            .some((m) => m.role === "system"),
        ).toBe(true);
        expect(
          r.tools?.some((t) => t.name === "create_scheduled_task") ?? false,
        ).toBe(false);
      },
    );

    it("appends paired tool results while replacing only the final round budget", async () => {
      const f = await setup(apiKind, true);
      await f.run(context());
      expect(f.requests).toHaveLength(2);
      const [first, second] = f.requests;
      expect(second!.messages.slice(0, first!.messages.length - 1)).toEqual(
        first!.messages.slice(0, -1),
      );
      expect(second!.messages.at(-1)!.content).not.toEqual(
        first!.messages.at(-1)!.content,
      );
      const taskTimes: unknown[] = [];
      for (const r of f.requests) {
        expect(r.messages.at(-1)!.role).toBe("user");
        const state = JSON.parse(
          (r.messages.at(-1)!.content as string)
            .replace("<agent_budget_status>", "")
            .replace("</agent_budget_status>", ""),
        ) as Record<string, unknown>;
        expect(state.currentTime).toBeDefined();
        taskTimes.push(state.currentTime);
        expect(state).not.toHaveProperty("guidance");
      }
      expect(new Set(taskTimes).size).toBe(1);
      expect(gatewaySystem(f.payloads[1]!)).toBe(gatewaySystem(f.payloads[0]!));
      for (const payload of f.payloads) {
        expect(payload).not.toHaveProperty("executionTime");
      }
      expect(gatewaySystem(f.payloads[0]!)).not.toContain('"modelRound":');
      expect(gatewaySystem(f.payloads[0]!)).toContain(
        "Only the application enforces quotas",
      );
      expect(
        second!.messages.filter(
          (m) =>
            typeof m.content === "string" &&
            m.content.includes("<agent_budget_status>"),
        ),
      ).toHaveLength(1);
      expect(second!.messages.find((m) => m.role === "tool")!.toolCallId).toBe(
        "fixture-call",
      );
      expect(f.payloads[1]!.tools).toEqual(f.payloads[0]!.tools);
      const wire = JSON.stringify(f.payloads[1]);
      expect(wire).toContain(
        apiKind === "responses" ? "function_call_output" : "tool_call_id",
      );
      expect(wire).toContain("fictional_tool_result");
    });
  },
);
