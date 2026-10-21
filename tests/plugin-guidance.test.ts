import { describe, it, expect } from "vitest";
import { pluginResultErrorCode } from "../modules/plugins/plugin-guidance.js";
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
});
