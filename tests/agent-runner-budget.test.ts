import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../modules/ai/agent-runner.js";
import { defaultAgentSettings } from "../modules/ai/agent-settings-types.js";
import type { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import type {
  AiRouteRequest,
  AiRouteSuccess,
  AiToolCall,
} from "../modules/ai/ai-types.js";
import type { MemoryService } from "../modules/memory/memory-service.js";
import { AgentSettingsService } from "../modules/ai/agent-settings-service.js";
import { InMemoryAgentSettingsRepository } from "./support/in-memory-agent-settings-repository.js";
const request: AiRouteRequest = {
  executionId: "fictional-run",
  nodeId: "ai",
  routeId: "fictional-route",
  messages: [{ role: "user", content: "查一下虚构成员的历史，再比较公开消息" }],
  maxOutputTokens: 1000,
  maxOutputCharacters: 4000,
  temperature: null,
  outputFormat: "text",
  protectedPrompt: null,
  webSearch: "auto",
  memoryEvent: { provider: "fictional", messageId: "fictional-trigger" },
};
function response(calls: AiToolCall[] = [], text = "虚构答案"): AiRouteSuccess {
  return {
    status: "succeeded",
    text,
    toolCalls: calls,
    providerId: "fictional",
    providerName: "fictional",
    providerVersion: 1,
    model: "fictional",
    routeVersion: 1,
    round: 1,
    attemptCount: 1,
    durationMs: 1,
    diagnostics: null,
  };
}
function call(
  id: number,
  name = "get_latest_chat_messages",
  args = "{}",
): AiToolCall {
  return { id: String(id), name, arguments: args };
}
function fixture(
  script: (
    request: AiRouteRequest,
    turn: number,
  ) => Promise<AiRouteSuccess> | AiRouteSuccess,
) {
  const requests: AiRouteRequest[] = [];
  const routing = {
    execute: async (r: AiRouteRequest) => {
      requests.push(structuredClone(r));
      return script(r, requests.length);
    },
  } as unknown as AiRoutingService;
  const execute = vi.fn(() =>
    Promise.resolve(
      JSON.stringify({
        status: "succeeded",
        evidence: [{ ref: "M1", text: "虚构聊天内容" }],
      }),
    ),
  );
  const memory = {
    repository: { scopeForEvent: () => Promise.resolve({}) },
    session: () =>
      Promise.resolve({
        execute,
        validate: () => Promise.resolve(true),
        render: (text: string) => text,
        references: () => ["M1"],
      }),
  } as unknown as MemoryService;
  const search = {
    isReady: () => Promise.resolve(true),
    search: vi.fn(() =>
      Promise.resolve({
        durationMs: 1,
        results: [
          {
            title: "fictional",
            snippet: "虚构公开内容",
            url: "https://fictional.example.test",
            publishedAt: null,
            source: null,
          },
        ],
      }),
    ),
  };
  return { routing, memory, search, requests, execute };
}
afterEach(() => vi.useRealTimers());
describe("AgentRunner shared quota integration", () => {
  it("shares mixed batches, counts invalid and cached calls, and pairs every tool call", async () => {
    const f = fixture((_, turn) =>
      turn === 1
        ? response([
            call(1),
            call(2, "web_search", '{"query":"fictional"}'),
            call(3, "web_search", '{"query":"fictional"}'),
            call(4, "web_search", "invalid"),
            call(5),
          ])
        : response(),
    );
    const result = await new AgentRunner(
      f.routing,
      f.search,
      undefined,
      undefined,
      { ...defaultAgentSettings, maxToolCalls: 4 },
      f.memory,
    ).run(request);
    expect(result.agentBudget).toMatchObject({
      modelTurns: 2,
      toolCalls: 4,
      reasons: ["tool-calls"],
      outcome: "budget-completed",
    });
    expect(f.search.search).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.requests[1]?.tools).toBeUndefined();
    const outputs = f.requests[1]!.messages.filter((m) => m.role === "tool");
    expect(outputs.map((o) => o.toolCallId)).toEqual(["1", "2", "3", "4", "5"]);
    expect(outputs[3]?.content).toContain("invalid-tool-arguments");
    expect(outputs[4]?.content).toContain("current-agent-run");
    expect(result.agentBudget?.toolOutputCharacters).toBe(
      outputs.slice(0, 4).reduce((n, o) => n + (o.content as string).length, 0),
    );
  });
  it("allows more than the old per-kind limits and applies settings only to the next run", async () => {
    const settings = new AgentSettingsService(
      new InMemoryAgentSettingsRepository(),
    );
    const view = vi.spyOn(settings, "view");
    const f = fixture(async (r) => {
      const count = r.messages.filter((m) => m.role === "tool").length;
      if (count === 1)
        await settings.update({
          ...defaultAgentSettings,
          maxToolCalls: 1,
          expectedVersion: 0,
        });
      return count < 7 && r.tools ? response([call(count)]) : response();
    });
    const runner = new AgentRunner(
      f.routing,
      undefined,
      undefined,
      undefined,
      undefined,
      f.memory,
      settings,
    );
    const result = await runner.run({ ...request, webSearch: "disabled" });
    expect(result.agentBudget).toMatchObject({
      settings: { version: 0, maxToolCalls: 10 },
      toolCalls: 7,
      modelTurns: 8,
      outcome: "completed",
    });
    const next = await runner.run({ ...request, webSearch: "disabled" });
    expect(next.agentBudget).toMatchObject({
      settings: { version: 1, maxToolCalls: 1 },
      toolCalls: 1,
      modelTurns: 2,
      outcome: "budget-completed",
    });
    expect(view).toHaveBeenCalledTimes(2);
  });
  it("reserves finalization and exactly one citation correction after exhausting N calls", async () => {
    const f = fixture((r, n) =>
      r.tools
        ? response([call(n)])
        : response([], n === 3 ? "[M99]" : "revised"),
    );
    f.memory.session = () =>
      Promise.resolve({
        execute: f.execute,
        validate: () => Promise.resolve(true),
        references: () => ["M1"],
        render: (text: string) => (text === "[M99]" ? null : text),
      } as never);
    const result = await new AgentRunner(
      f.routing,
      undefined,
      undefined,
      undefined,
      { ...defaultAgentSettings, maxToolCalls: 2 },
      f.memory,
    ).run({ ...request, webSearch: "disabled" });
    expect(result).toMatchObject({
      status: "succeeded",
      text: "revised",
      agentBudget: { modelTurns: 4, toolCalls: 2 },
    });
    expect(f.requests.slice(2).every((r) => !r.tools)).toBe(true);
  });
  it("finalizes on character truncation while preserving source JSON", async () => {
    const f = fixture((_, n) => (n === 1 ? response([call(1)]) : response()));
    f.execute.mockResolvedValue(
      JSON.stringify({
        status: "succeeded",
        evidence: [
          { ref: "M1", text: "retained fictional" },
          { ref: "M2", text: "x".repeat(6000) },
        ],
      }),
    );
    const result = await new AgentRunner(
      f.routing,
      undefined,
      undefined,
      undefined,
      { ...defaultAgentSettings, maxToolOutputCharacters: 4000 },
      f.memory,
    ).run({ ...request, webSearch: "disabled" });
    expect(result.agentBudget).toMatchObject({
      reasons: ["tool-output"],
      outcome: "budget-completed",
    });
    const output = f.requests[1]?.messages.find((m) => m.role === "tool");
    expect(JSON.parse(output!.content as string)).toMatchObject({
      status: "succeeded",
      evidence: [{ ref: "M1" }],
      truncated: true,
    });
    expect(f.requests[1]?.tools).toBeUndefined();
  });
  it("closes tools after a deadline and still honors required web failure policy", async () => {
    vi.useFakeTimers();
    const f = fixture((_, n) =>
      n === 1
        ? response([call(1, "web_search", '{"query":"fictional"}')])
        : response(),
    );
    f.search.search.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10000));
      return { durationMs: 10000, results: [] };
    });
    const runner = new AgentRunner(f.routing, f.search, undefined, undefined, {
      ...defaultAgentSettings,
      maxToolDurationMs: 5000,
    });
    const running = runner.run(request);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await running;
    expect(result).toMatchObject({
      status: "succeeded",
      agentBudget: {
        toolDurationMs: 5000,
        reasons: ["tool-duration"],
        outcome: "budget-completed",
      },
    });
    expect(f.requests[1]?.tools).toBeUndefined();
    f.requests.length = 0;
    const required = runner.run({ ...request, webSearch: "required" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await required).toMatchObject({
      status: "failed",
      code: "AI_AGENT_TOOL_TIMEOUT",
      agentBudget: { outcome: "failed" },
    });
  });
  it("preserves a snapshot when the provider ignores final tool closure", async () => {
    const f = fixture((_, n) => response([call(n)]));
    const result = await new AgentRunner(
      f.routing,
      undefined,
      undefined,
      undefined,
      { ...defaultAgentSettings, maxToolCalls: 1 },
      f.memory,
    ).run({ ...request, webSearch: "disabled" });
    expect(result).toMatchObject({
      status: "failed",
      code: "AI_AGENT_TOOL_LIMIT_EXCEEDED",
      agentBudget: { modelTurns: 2, toolCalls: 1, outcome: "failed" },
    });
  });
});
