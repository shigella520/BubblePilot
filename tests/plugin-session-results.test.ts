import {
  connectionSchema,
  connectionCallTimeoutMs,
} from "../modules/plugins/plugin-types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginSession } from "../modules/plugins/plugin-session.js";
import { PluginMcp } from "../modules/plugins/plugin-mcp.js";
import { AgentToolRegistry } from "../modules/ai/agent-tool-registry.js";
import type { MultimodalToolResult } from "../modules/ai/agent-tool-registry.js";
import type { PluginService } from "../modules/plugins/plugin-service.js";
import type { InstalledPlugin } from "../modules/plugins/plugin-types.js";
const tool = {
  server: "mock",
  hash: "h",
  definition: {
    name: "page",
    description: "fictional",
    parameters: { type: "object", properties: {} },
  },
};
const plugin: InstalledPlugin = {
  id: "fixture",
  name: "Fixture",
  enabled: true,
  version: 1,
  revision: "r1",
  package: {
    name: "Fixture",
    version: "1",
    description: "fictional",
    format: "portable-1",
    hash: "r1",
    files: {},
    skills: [],
    servers: [],
  },
  config: {
    tools: [tool],
    disabledTools: [],
    disabledSkills: [],
    connections: {
      mock: {
        url: "https://example.test/mcp",
        auth: "none",
        header: "X-Key",
        allowPrivate: false,
      },
    },
  },
};
function fixture(
  callTimeoutSeconds?: number,
  parameters?: Record<string, unknown>,
) {
  const p = structuredClone(plugin);
  if (parameters) p.config.tools[0]!.definition.parameters = parameters;
  if (callTimeoutSeconds !== undefined)
    p.config.connections.mock!.callTimeoutSeconds = callTimeoutSeconds;
  const session = new PluginSession(
    { get: () => Promise.resolve(p) } as unknown as PluginService,
    [structuredClone(p)],
  );
  const connect = vi.spyOn(PluginMcp.prototype, "connect").mockResolvedValue();
  const discover = vi
    .spyOn(PluginMcp.prototype, "discover")
    .mockResolvedValue([p.config.tools[0]!]);
  vi.spyOn(PluginMcp.prototype, "close").mockResolvedValue();
  const call = vi.spyOn(PluginMcp.prototype, "call").mockResolvedValue({
    status: "success",
    responseBytes: 25000,
    content: [{ type: "text", text: "虚构正文\n".repeat(8000) }],
  });
  const registry = new AgentToolRegistry();
  session.register(registry);
  const ext = registry.get(
    registry.definitions().find((t) => t.name.startsWith("ext_"))!.name,
  )!;
  const controller = new AbortController();
  const ctx = {
    signal: controller.signal,
    deadline: Date.now() + 90000,
    maxOutputCharacters: 64000,
    toolCallId: "first",
  };
  return {
    p,
    session,
    registry,
    call,
    connect,
    discover,
    ext,
    controller,
    ctx,
  };
}
afterEach(() => vi.restoreAllMocks());
describe("MCP large-result session lifecycle", () => {
  it("keeps safe command diagnostics in audit while raw command output stays in model results", async () => {
    const f = fixture();
    f.call.mockResolvedValueOnce({
      status: "error",
      responseBytes: 300,
      errorCode: "PLUGIN_COMMAND_FAILED",
      content: [],
      structuredContent: {
        status: "command_failed",
        exitCode: 1,
        stdout:
          '{"status":"failed","code":"svg_path_denied","private":"fictional hidden"}',
        stderr: "fictional private stderr",
      },
    });
    const result = (await f.ext.execute("{}", f.ctx)) as MultimodalToolResult;
    expect(result.diagnostics).toMatchObject({
      outcome: "error",
      errorCode: "PLUGIN_COMMAND_FAILED",
      remoteStatus: "command_failed",
      exitCode: 1,
      failureReason: "svg_path_denied",
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain(
      "fictional hidden",
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain("private stderr");
    expect(result.text).toContain("fictional hidden");
    await f.session.close();
  });
  it("passes long multiline file contents unchanged and rejects the old envelope", async () => {
    const f = fixture(undefined, {
      type: "object",
      properties: { path: { type: "string" }, text: { type: "string" } },
      required: ["path", "text"],
    });
    const args = {
      path: "/workspace/draw.py",
      text: String.raw`# Fictional drawing
svg = '<svg width="240"><text>示例</text></svg>'
print("quote: \"; slash: \\")
`.repeat(80),
    };
    expect(f.ext.definition.parameters.properties).not.toHaveProperty(
      "arguments_json",
    );
    const old = (await f.ext.execute(
      JSON.stringify({ arguments_json: JSON.stringify(args) }),
      f.ctx,
    )) as MultimodalToolResult;
    expect(JSON.parse(old.text)).toMatchObject({
      code: "PLUGIN_INVALID_TOOL_ARGUMENTS",
      retryInThisAnswer: true,
    });
    expect(f.connect).not.toHaveBeenCalled();
    await f.ext.execute(JSON.stringify(args), f.ctx);
    expect(f.call.mock.calls[0]?.[1]).toEqual(args);
    await f.session.close();
  });
  it("preserves a direct tool field literally named arguments_json", async () => {
    const f = fixture(undefined, {
      type: "object",
      properties: { arguments_json: { type: "string" } },
      required: ["arguments_json"],
    });
    await f.ext.execute(JSON.stringify({ arguments_json: "not JSON" }), f.ctx);
    expect(f.call.mock.calls[0]?.[1]).toEqual({ arguments_json: "not JSON" });
    await f.session.close();
  });
  it("keeps complex arguments in an explicit envelope and reports malformed JSON safely", async () => {
    const f = fixture(undefined, {
      type: "object",
      properties: {
        schema: {
          type: "object",
          propertyNames: { type: "string" },
          additionalProperties: true,
        },
      },
      required: ["schema"],
    });
    const malformed = (await f.ext.execute(
      JSON.stringify({
        arguments_json: '{"schema":{"fictional-private-value":',
      }),
      f.ctx,
    )) as MultimodalToolResult;
    expect(JSON.parse(malformed.text)).toMatchObject({
      code: "PLUGIN_INVALID_TOOL_ARGUMENTS",
      issues: [{ field: "arguments_json", code: "invalid_json_object" }],
      retryInThisAnswer: true,
    });
    expect(malformed.text).not.toContain("fictional-private-value");
    expect(f.connect).not.toHaveBeenCalled();
    const args = { schema: { arbitrary: { type: "string" } } };
    await f.ext.execute(
      JSON.stringify({ arguments_json: JSON.stringify(args) }),
      f.ctx,
    );
    expect(f.call.mock.calls[0]?.[1]).toEqual(args);
    await f.session.close();
  });
  it("returns actionable envelope errors before calling the remote tool", async () => {
    const f = fixture(undefined, {
      type: "object",
      properties: {
        schema: {
          type: "object",
          propertyNames: { type: "string" },
          additionalProperties: true,
        },
      },
      required: ["schema"],
    });
    const output = (await f.ext.execute("{}", f.ctx)) as MultimodalToolResult;
    expect(JSON.parse(output.text)).toMatchObject({
      code: "PLUGIN_INVALID_TOOL_ARGUMENTS",
      issues: [{ field: "arguments_json", code: "required" }],
      retryInThisAnswer: true,
    });
    expect(f.call).not.toHaveBeenCalled();
    const malformed = (await f.ext.execute(
      '{"arguments_json":',
      f.ctx,
    )) as MultimodalToolResult;
    expect(JSON.parse(malformed.text)).toMatchObject({
      code: "PLUGIN_INVALID_ARGUMENTS",
      retryInThisAnswer: true,
    });
    expect(f.call).not.toHaveBeenCalled();
    await f.session.close();
  });
  it("reports original MCP contract errors without connecting to the remote service", async () => {
    const f = fixture(undefined, {
      type: "object",
      properties: { path: { type: "string" }, timeout: { type: "integer" } },
      required: ["path"],
      additionalProperties: false,
    });
    const output = (await f.ext.execute(
      JSON.stringify({ timeout: null }),
      f.ctx,
    )) as MultimodalToolResult;
    expect(JSON.parse(output.text)).toMatchObject({
      code: "PLUGIN_INVALID_TOOL_ARGUMENTS",
      issues: [{ field: "path", code: "required" }],
      retryInThisAnswer: true,
    });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
    await f.session.close();
  });
  it("checks authorization again on reads and caps the remote timeout", async () => {
    const f = fixture();
    const output = (await f.ext.execute("{}", f.ctx)) as MultimodalToolResult;
    expect(f.call.mock.calls[0]?.[3]).toBe(45000);
    expect(output.diagnostics).toMatchObject({
      delivery: "partial",
      responseBytes: 25000,
    });
    await output.validateCommit?.();
    output.commitResult?.();
    f.p.config.disabledTools.push("mock/page");
    const denied = (await f.registry
      .get("read_tool_result")!
      .execute(
        JSON.stringify({ result_ref: parsePayload(output.text).result_ref }),
        f.ctx,
      )) as MultimodalToolResult;
    expect(denied.diagnostics?.errorCode).toBe("PLUGIN_PERMISSION_REVOKED");
    expect(f.call).toHaveBeenCalledTimes(1);
    await f.session.close();
  });
  it("never provides a commit after abort or elapsed deadline", async () => {
    for (const abort of [true, false]) {
      const f = fixture();
      f.call.mockImplementationOnce(async () => {
        await Promise.resolve();
        if (abort) f.controller.abort();
        else f.ctx.deadline = Date.now() - 1;
        return {
          status: "success",
          responseBytes: 30000,
          content: [{ type: "text", text: "x".repeat(30000) }],
        };
      });
      const output = (await f.ext.execute("{}", f.ctx)) as MultimodalToolResult;
      expect(output.commitResult).toBeUndefined();
      expect(output.diagnostics?.outcome).toBe("error");
      expect(parsePayload(output.text).result_ref).toBeUndefined();
      await f.session.close();
    }
  });
  it("keeps insufficient character budget separate from timeout", async () => {
    const f = fixture();
    const output = (await f.ext.execute("{}", {
      ...f.ctx,
      maxOutputCharacters: 10,
    })) as MultimodalToolResult;
    expect(parsePayload(output.text)).toMatchObject({
      code: "PLUGIN_RESULT_BUDGET",
      reason: "tool-output",
    });
    expect(output.commitResult).toBeUndefined();
    await f.session.close();
  });
});

function parsePayload(text: string) {
  return JSON.parse(text) as {
    result_ref: string;
    text: string;
    matches: Array<{ matchOffset: number }>;
  };
}

it("uses the service timeout, caps it by the remaining budget and reports it on failure", async () => {
  const f = fixture(150);
  try {
    f.ctx.deadline = Date.now() + 180000;
    await f.ext.execute("{}", f.ctx);
    expect(f.call.mock.calls[0]?.[3]).toBe(150000);
    f.ctx.deadline = Date.now() + 1200;
    f.call.mockRejectedValueOnce(new Error("fictional transport failure"));
    const failed = (await f.ext.execute("{}", f.ctx)) as MultimodalToolResult;
    expect(f.call.mock.calls[1]?.[3]).toBeGreaterThan(0);
    expect(f.call.mock.calls[1]?.[3]).toBeLessThanOrEqual(1200);
    expect(failed.diagnostics).toMatchObject({
      outcome: "error",
      callTimeoutMs: 150000,
    });
    f.ctx.deadline = Date.now() - 1;
    await f.ext.execute("{}", f.ctx);
    expect(f.call).toHaveBeenCalledTimes(2);
  } finally {
    await f.session.close();
  }
});

it("validates per-service timeout values and preserves defaults for older connections", () => {
  const base = { url: "https://example.test/mcp" };
  expect(connectionCallTimeoutMs(connectionSchema.parse(base))).toBe(45000);
  expect(
    connectionCallTimeoutMs(
      connectionSchema.parse({ ...base, callTimeoutSeconds: 180 }),
    ),
  ).toBe(180000);
  for (const callTimeoutSeconds of [4, 181, 5.5, "150", null])
    expect(
      connectionSchema.safeParse({ ...base, callTimeoutSeconds }).success,
    ).toBe(false);
});
