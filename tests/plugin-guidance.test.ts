import { describe, it, expect } from "vitest";
import {
  pluginErrorGuidance,
  pluginResultErrorCode,
  pluginFailureDetails,
  pluginResultFailureGuidance,
  pluginGuidance,
} from "../modules/plugins/plugin-guidance.js";
describe("plugin failure classification", () => {
  it("reports safe command failure evidence without exposing output and offers only safe corrections", () => {
    const result = {
      status: "command_failed",
      exitCode: 1,
      sessionUsable: true,
      stdout:
        '{"status":"failed","code":"svg_path_denied","private":"fictional secret"}',
      stderr: "private error",
    };
    expect(pluginResultErrorCode(result)).toBe("PLUGIN_COMMAND_FAILED");
    expect(pluginFailureDetails(result)).toEqual({
      remoteStatus: "command_failed",
      exitCode: 1,
      failureReason: "svg_path_denied",
    });
    expect(
      pluginFailureDetails({
        ...result,
        stdout: '{"status":"failed","code":"private"}',
      }),
    ).not.toHaveProperty("failureReason");
    expect(pluginResultFailureGuidance(result)).toMatchObject({
      retryInThisAnswer: true,
    });
    expect(
      pluginResultFailureGuidance({ ...result, sessionUsable: false }),
    ).toMatchObject({ retryInThisAnswer: false });
    expect(
      pluginResultFailureGuidance({
        status: "result_unknown",
        sessionUsable: true,
      }),
    ).toMatchObject({ retryInThisAnswer: false });
    expect(pluginGuidance).not.toContain("web_search");
    expect(
      pluginErrorGuidance("PLUGIN_MCP_TRANSPORT_ERROR").nextAction,
    ).not.toContain("web search");
  });
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
