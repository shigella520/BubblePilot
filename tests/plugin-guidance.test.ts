import { describe, it, expect } from "vitest";
import {
  pluginErrorGuidance,
  pluginResultErrorCode,
} from "../modules/plugins/plugin-guidance.js";
describe("plugin failure classification", () => {
  it("only recognizes explicit structured quota and rate codes", () => {
    expect(
      pluginResultErrorCode({ error: { code: "INSUFFICIENT_CREDITS" } }),
    ).toBe("PLUGIN_QUOTA_EXHAUSTED");
    expect(pluginResultErrorCode({ code: "RATE_LIMIT_EXCEEDED" })).toBe(
      "PLUGIN_RATE_LIMITED",
    );
    expect(pluginResultErrorCode({ message: "quota exceeded" })).toBe(
      "PLUGIN_REMOTE_TOOL_ERROR",
    );
    expect(pluginResultErrorCode({ code: "unknown" })).toBe(
      "PLUGIN_REMOTE_TOOL_ERROR",
    );
    expect(pluginResultErrorCode(null)).toBe("PLUGIN_REMOTE_TOOL_ERROR");
  });
  it("explains failures and only suggests correcting pre-execution argument errors", () => {
    expect(pluginErrorGuidance("PLUGIN_INVALID_TOOL_ARGUMENTS")).toMatchObject({
      retryInThisAnswer: true,
    });
    expect(pluginErrorGuidance("PLUGIN_MCP_TIMEOUT")).toMatchObject({
      retryInThisAnswer: false,
      failureReason:
        "The plugin call timed out; the remote outcome may be unknown.",
    });
    expect(pluginErrorGuidance("PLUGIN_MCP_TIMEOUT").nextAction).toContain(
      "do not automatically repeat",
    );
  });
});
