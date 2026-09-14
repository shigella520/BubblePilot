import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentBudget,
  AgentToolTimeout,
  fitToolOutput,
} from "../modules/ai/agent-budget.js";
import { defaultAgentSettings } from "../modules/ai/agent-settings-types.js";
const settings = {
  ...defaultAgentSettings,
  source: "defaults" as const,
  version: 0,
  updatedAt: null,
};
afterEach(() => vi.useRealTimers());
describe("shared Agent budget", () => {
  it("fits whole structured sources and never labels discarded results as no-results", () => {
    const evidence = [
      { ref: "M1", text: "fictional first", senderId: "fictional" },
      { ref: "M2", text: "x".repeat(1000) },
    ];
    const output = fitToolOutput(
      JSON.stringify({ status: "succeeded", evidence }),
      250,
    );
    expect(JSON.parse(output.content!)).toEqual({
      status: "succeeded",
      evidence: [evidence[0]],
      truncated: true,
      reason: "tool-output",
    });
    expect(
      fitToolOutput(JSON.stringify({ status: "succeeded", evidence }), 5),
    ).toEqual({ content: null, truncated: true });
  });
  it("counts actual serialized output including repeated results and source metadata", async () => {
    const budget = new AgentBudget(settings);
    const output = JSON.stringify({
      status: "succeeded",
      evidence: [{ ref: "M1", text: "虚构" }],
    });
    for (let n = 0; n < 3; n++)
      budget.append(await budget.execute(() => Promise.resolve(output)));
    expect(budget.snapshot.toolCalls).toBe(3);
    expect(budget.snapshot.toolOutputCharacters).toBe(output.length * 3);
    expect(budget.exhausted).toBe(false);
  });
  it("aborts over-time operations, excludes model waiting time, and bounds duration", async () => {
    vi.useFakeTimers();
    const budget = new AgentBudget({ ...settings, maxToolDurationMs: 5000 });
    let signal: AbortSignal | undefined;
    const result = budget.execute(async (ctx) => {
      signal = ctx.signal;
      await new Promise((resolve) => setTimeout(resolve, 8000));
      return "late";
    });
    const assertion = expect(result).rejects.toBeInstanceOf(AgentToolTimeout);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(budget.snapshot).toMatchObject({
      toolCalls: 1,
      toolDurationMs: 5000,
      reasons: ["tool-duration"],
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(budget.snapshot.toolDurationMs).toBe(5000);
  });
  it("does not charge control messages to the evidence budget", () => {
    const budget = new AgentBudget(settings);
    const output = budget.append(
      JSON.stringify({
        evidence: [{ text: "x".repeat(25000) }],
        status: "succeeded",
      }),
    );
    expect(JSON.parse(output)).toMatchObject({
      status: "unavailable",
      budgetScope: "current-agent-run",
    });
    expect(budget.snapshot).toMatchObject({
      toolOutputCharacters: 0,
      reasons: ["tool-output"],
    });
  });
});
