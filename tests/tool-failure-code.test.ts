import { expect, it } from "vitest";
import { safeBuiltinFailureCode } from "../modules/ai/tool-failure-code.js";
import {
  pluginCommandErrorLabel,
  pluginToolErrorLabel,
} from "../apps/web/src/utils/plugin-tool-diagnostics.js";
it("retains structured built-in codes without allowing arbitrary messages into audit", () => {
  for (const code of [
    "IMAGE_PREPARATION_FAILED",
    "ATTACHMENT_TYPE_MISMATCH",
    "TASK_OPERATION_FAILED",
    "MEME_TOOL_UNAVAILABLE",
  ])
    expect(safeBuiltinFailureCode(code)).toBe(code);
  for (const code of [
    undefined,
    "private url https://example.test/token",
    {},
    "unknown",
  ])
    expect(safeBuiltinFailureCode(code)).toBe("AI_AGENT_TOOL_FAILED");
  expect(pluginToolErrorLabel("IMAGE_PREPARATION_FAILED")).toContain(
    "附件准备失败",
  );
  expect(
    pluginCommandErrorLabel({ exitCode: 1, failureReason: "svg_path_denied" }),
  ).toBe("退出码 1 · 渲染路径必须是 /workspace/ 下的绝对路径");
  expect(pluginCommandErrorLabel({ failureReason: "private stdout" })).toBe("");
});
