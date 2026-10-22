import { describe, expect, it } from "vitest";
import {
  pluginToolPresentation,
  pluginToolErrorLabel,
} from "../apps/web/src/utils/plugin-tool-diagnostics.js";

const call = {
  toolName: "ext_fictional",
  nodeId: "ai",
  requestDetails: {
    kind: "plugin",
    pluginId: "p1",
    revision: "r1",
    server: "example-mcp",
    tool: "read_page",
  },
  responseDetails: null,
};
const node = (name: string, revision = "r1", nodeId = "ai") => ({
  nodeId,
  outputSummary: { agentBudget: { plugins: [{ id: "p1", name, revision }] } },
});
describe("plugin audit presentation", () => {
  it("shows MCP and original tool on old calls using their pinned snapshot", () => {
    expect(
      pluginToolPresentation(call, [node("Example plugin")]),
    ).toMatchObject({
      title: "example-mcp / read_page",
      plugin: "Example plugin",
      revision: "r1",
    });
  });
  it("prefers the call name snapshot and preserves identity on failure", () => {
    expect(
      pluginToolPresentation(
        {
          ...call,
          requestDetails: { ...call.requestDetails, pluginName: "Pinned" },
          responseDetails: { outcome: "error" },
        },
        [node("Changed")],
      )?.plugin,
    ).toBe("Pinned");
  });
  it("does not infer names from another node, revision or ambiguous attempts", () => {
    for (const nodes of [
      [node("Other", "r2")],
      [node("Other", "r1", "other")],
      [node("One"), node("Two")],
    ])
      expect(pluginToolPresentation(call, nodes)?.plugin).toBe(
        "未记录插件名称",
      );
    expect(
      pluginToolPresentation({ ...call, requestDetails: { kind: "plugin" } })
        ?.title,
    ).toBe("ext_fictional");
    expect(
      pluginToolPresentation({ ...call, requestDetails: null }),
    ).toBeNull();
  });
  it("does not infer quota or authentication from generic tool failure", () => {
    expect(pluginToolErrorLabel("PLUGIN_REMOTE_TOOL_ERROR")).toContain(
      "未记录具体原因",
    );
    expect(pluginToolErrorLabel("PLUGIN_REMOTE_AUTH_DENIED")).toContain("认证");
    expect(pluginToolErrorLabel("UNKNOWN")).toBeNull();
  });
});

it("explains partial delivery and links local reads to the original MCP tool", async () => {
  const { pluginDeliveryLabel } =
    await import("../apps/web/src/utils/plugin-tool-diagnostics.js");
  expect(pluginDeliveryLabel(null)).toBe("未记录详细交付信息");
  expect(
    pluginDeliveryLabel({ diagnosticVersion: 1, delivery: "partial" }),
  ).toContain("部分内容");
  expect(
    pluginDeliveryLabel({
      diagnosticVersion: 1,
      delivery: "read",
      offset: 20,
      nextOffset: 40,
    }),
  ).toContain("20—40");
  expect(
    pluginDeliveryLabel({
      diagnosticVersion: 1,
      delivery: "search",
      matchCount: 0,
    }),
  ).toContain("0 处");
  expect(
    pluginToolPresentation({
      ...call,
      toolName: "read_tool_result",
      requestDetails: { kind: "plugin" },
      responseDetails: { ...call.requestDetails, parentToolCallId: "original" },
    })?.title,
  ).toBe("读取结果 · example-mcp / read_page");
  expect(pluginToolErrorLabel("PLUGIN_RESULT_STORAGE_LIMIT")).toContain("暂存");
});
