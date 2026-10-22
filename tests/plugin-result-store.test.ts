import { describe, expect, it, vi } from "vitest";
import {
  PluginResultStore,
  normalizeMcpResult,
} from "../modules/plugins/plugin-result-store.js";
import { AgentBudget } from "../modules/ai/agent-budget.js";
import { defaultAgentSettings } from "../modules/ai/agent-settings-types.js";
const source = {
  pluginId: "fixture",
  pluginName: "Fixture",
  revision: "r1",
  server: "mock",
  tool: "page",
  resultStatus: "success",
  parentToolCallId: "call1",
};
const result = (text: string) => ({
  status: "success",
  content: [{ type: "text", text }],
});
const context = () =>
  new AgentBudget({
    ...defaultAgentSettings,
    source: "defaults",
    version: 0,
    updatedAt: null,
  });

describe("run-local MCP results", () => {
  it("deduplicates only equal parsed JSON, preserving other blocks and original payload", () => {
    const input = {
      content: [
        { type: "text", text: '{"b":[2],"a":1}' },
        { type: "text", text: "extra" },
      ],
      structuredContent: { a: 1, b: [2] },
    };
    expect(normalizeMcpResult(input).content).toEqual([
      { type: "text", text: "extra" },
    ]);
    expect(input.content).toHaveLength(2);
    expect(
      normalizeMcpResult({ ...input, structuredContent: { a: 1, b: [3] } })
        .content,
    ).toHaveLength(2);
  });
  it("fits complete envelopes, commits once, searches middle text, and reads Unicode offsets", async () => {
    const store = new PluginResultStore();
    const authorize = vi.fn(() => Promise.resolve());
    const text =
      "甲😀\n".repeat(6000) + "退款期限为七天" + "末尾\n".repeat(6000);
    const prepared = store.prepare(result(text), source, authorize, 16000);
    expect(prepared.text.length).toBeLessThanOrEqual(16000);
    const ref = parsePayload(prepared.text).result_ref;
    await expect(
      store.access({ result_ref: ref }, false, 16000),
    ).rejects.toMatchObject({ code: "PLUGIN_REFERENCE_UNAVAILABLE" });
    prepared.commit?.();
    prepared.commit?.();
    const found = await store.access(
      { result_ref: ref, query: "退款" },
      true,
      16000,
    );
    const match = parsePayload(found.text).matches[0]!;
    expect(match.matchOffset).toBe(18000);
    const read = await store.access(
      { result_ref: ref, offset: match.matchOffset, limit: 7 },
      false,
      16000,
    );
    expect(parsePayload(read.text).text).toBe("退款期限为七天");
    expect(authorize).toHaveBeenCalledTimes(4);
    expect(read.metadata.parentToolCallId).toBe("call1");
    store.close();
    await expect(
      store.access({ result_ref: ref }, false, 16000),
    ).rejects.toMatchObject({ code: "PLUGIN_REFERENCE_UNAVAILABLE" });
  });
  it("does not end the run on partial delivery and charges each subsequent read", async () => {
    const store = new PluginResultStore();
    const budget = context();
    const prepared = await budget.execute((ctx) =>
      Promise.resolve(
        store.prepare(
          result("x".repeat(80000)),
          source,
          () => Promise.resolve(),
          ctx.maxOutputCharacters,
        ),
      ),
    );
    prepared.commit?.();
    budget.append(prepared.text);
    expect(budget.exhausted).toBe(false);
    const ref = parsePayload(prepared.text).result_ref;
    for (let i = 0; i < 2; i++) {
      const read = await budget.execute((ctx) =>
        store.access(
          { result_ref: ref, limit: 100 },
          false,
          ctx.maxOutputCharacters,
        ),
      );
      budget.append(read.text);
    }
    expect(budget.snapshot.toolCalls).toBe(3);
    expect(budget.snapshot.toolOutputCharacters).toBeGreaterThan(
      prepared.text.length,
    );
  });
  it("isolates runs, rejects invalid parameters, revocation, and capacity overflow", async () => {
    const store = new PluginResultStore();
    const auth = vi.fn(() => Promise.resolve());
    const prepared = store.prepare(
      result("x".repeat(20000)),
      source,
      auth,
      16000,
    );
    prepared.commit?.();
    const ref = parsePayload(prepared.text).result_ref;
    await expect(
      new PluginResultStore().access({ result_ref: ref }, false, 16000),
    ).rejects.toThrow();
    for (const args of [
      { result_ref: ref, offset: -1 },
      { result_ref: ref, limit: 0 },
      { result_ref: ref, path: "/tmp" },
    ])
      await expect(store.access(args, false, 16000)).rejects.toMatchObject({
        code: "PLUGIN_INVALID_ARGUMENTS",
      });
    auth.mockRejectedValueOnce(new Error("revoked"));
    await expect(
      store.access({ result_ref: ref }, false, 16000),
    ).rejects.toThrow("revoked");
    expect(() =>
      new PluginResultStore(100).prepare(
        result("x".repeat(20000)),
        source,
        auth,
        16000,
      ),
    ).toThrow();
    expect(() =>
      store.prepare(result("x".repeat(20000)), source, auth, 1),
    ).toThrow();
  });
  it("keeps remote errors, escaped content and empty results intact", () => {
    const store = new PluginResultStore();
    const small = result("");
    expect(
      parsePayload(
        store.prepare(small, source, () => Promise.resolve(), 16000).text,
      ),
    ).toEqual(small);
    const large = {
      ...result('"😀\\\n'.repeat(10000)),
      status: "error",
      errorCode: "PLUGIN_REMOTE_TOOL_ERROR",
    };
    const output = store.prepare(
      large,
      { ...source, resultStatus: "error" },
      () => Promise.resolve(),
      2000,
    );
    expect(output.text.length).toBeLessThanOrEqual(2000);
    expect(parsePayload(output.text)).toMatchObject({
      status: "error",
      delivery: "partial",
      errorCode: "PLUGIN_REMOTE_TOOL_ERROR",
    });
    expect(output.text).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
  });
});

function parsePayload(text: string) {
  return JSON.parse(text) as {
    result_ref: string;
    text: string;
    matches: Array<{ matchOffset: number }>;
  };
}
