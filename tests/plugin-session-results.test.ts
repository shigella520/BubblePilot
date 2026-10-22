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
function fixture() {
  const p = structuredClone(plugin);
  const session = new PluginSession(
    { get: () => Promise.resolve(p) } as unknown as PluginService,
    [structuredClone(p)],
  );
  vi.spyOn(PluginMcp.prototype, "connect").mockResolvedValue();
  vi.spyOn(PluginMcp.prototype, "discover").mockResolvedValue([tool]);
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
  return { p, session, registry, call, ext, controller, ctx };
}
afterEach(() => vi.restoreAllMocks());
describe("MCP large-result session lifecycle", () => {
  it("checks authorization again on reads and caps the remote timeout", async () => {
    const f = fixture();
    const output = (await f.ext.execute(
      '{"arguments_json":"{}"}',
      f.ctx,
    )) as MultimodalToolResult;
    expect(f.call.mock.calls[0]?.[3]).toBe(45000);
    expect(output.diagnostics).toMatchObject({
      delivery: "partial",
      responseBytes: 25000,
    });
    output.commit?.();
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
      const output = (await f.ext.execute(
        '{"arguments_json":"{}"}',
        f.ctx,
      )) as MultimodalToolResult;
      expect(output.commit).toBeUndefined();
      expect(output.diagnostics?.outcome).toBe("error");
      expect(parsePayload(output.text).result_ref).toBeUndefined();
      await f.session.close();
    }
  });
  it("keeps insufficient character budget separate from timeout", async () => {
    const f = fixture();
    const output = (await f.ext.execute('{"arguments_json":"{}"}', {
      ...f.ctx,
      maxOutputCharacters: 10,
    })) as MultimodalToolResult;
    expect(parsePayload(output.text)).toMatchObject({
      code: "PLUGIN_RESULT_BUDGET",
      reason: "tool-output",
    });
    expect(output.commit).toBeUndefined();
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
