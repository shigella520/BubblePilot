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

it("distinguishes prepared media from actual dispatched requests", async () => {
  const { pluginImageRows } =
    await import("../apps/web/src/utils/plugin-tool-diagnostics.js");
  const details = {
    images: [
      {
        imageInputId: "fictional-image",
        block_index: 1,
        status: "committed",
        width: 32,
        height: 24,
        bytes: 100,
      },
    ],
  };
  expect(pluginImageRows(details)[0]?.state).toContain("未记录实际发送");
  expect(
    pluginImageRows(details, [
      {
        status: "succeeded",
        diagnostics: {
          imageInputs: {
            dispatched: true,
            images: [{ imageInputId: "fictional-image" }],
          },
        },
      },
    ])[0]?.state,
  ).toContain("请求成功");
});

describe("chat attachment import presentation", () => {
  const importCall = (
    requestDetails: Record<string, unknown>,
    responseDetails: Record<string, unknown> | null,
  ) => ({
    toolName: "import_chat_attachment",
    nodeId: "ai",
    requestDetails: {
      kind: "attachment",
      tool: "import_chat_attachment",
      ...requestDetails,
    },
    responseDetails,
  });
  it("labels the actual target of a multi-target import", () => {
    expect(
      pluginToolPresentation(
        importCall(
          {
            targets: [
              { target: "sandbox", pluginId: "s", server: "opensandbox" },
              { target: "image_generator", pluginId: "g", server: "image-gen" },
            ],
          },
          {
            outcome: "success",
            target: "image_generator",
            pluginId: "g",
            server: "image-gen",
          },
        ),
      ),
    ).toMatchObject({
      title: "图片导入（生图） · image-gen",
      server: "image-gen",
      id: "g",
    });
  });
  it("keeps single-target sandbox imports unchanged", () => {
    expect(
      pluginToolPresentation(
        importCall(
          { pluginId: "s", server: "opensandbox" },
          { outcome: "success", pluginId: "s", server: "opensandbox" },
        ),
      ),
    ).toMatchObject({ title: "附件导入 · opensandbox" });
  });
});
