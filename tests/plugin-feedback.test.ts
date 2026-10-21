import { describe, expect, it } from "vitest";
import { ApiError } from "../apps/web/src/services/api.js";
import {
  pluginErrorMessage,
  canInspectPlugin,
} from "../apps/web/src/utils/plugin-feedback.js";
import { pluginImportErrorCode } from "../modules/plugins/plugin-import-error.js";
import { ApplicationError } from "../app/errors.js";

describe("plugin import diagnostics", () => {
  it("only asks to unlock when the server requires sensitive verification", () => {
    expect(
      pluginErrorMessage(
        new ApiError(403, "SENSITIVE_AUTH_REQUIRED", "English error", null),
      ),
    ).toContain("顶栏解锁");
    for (const code of [
      "IMPORT_FAILED",
      "PLUGIN_NO_PLUGIN_MANIFEST",
      "PLUGIN_GIT_FAILED",
      "PLUGIN_GIT_TIMEOUT",
      "PLUGIN_ARCHIVE_TOO_LARGE",
    ]) {
      expect(pluginErrorMessage(new Error(code))).not.toContain("顶栏解锁");
      expect(pluginErrorMessage(new Error(code))).not.toBe(code);
    }
  });
  it("does not offer inspection for failed, pending, or obsolete selections", () => {
    expect(canInspectPlugin(null, ".")).toBe(false);
    expect(canInspectPlugin({ state: "failed", directories: ["."] }, ".")).toBe(
      false,
    );
    expect(canInspectPlugin({ state: "loading", directories: [] }, "")).toBe(
      false,
    );
    expect(
      canInspectPlugin(
        { state: "staged", directories: ["plugins/a"] },
        "plugins/b",
      ),
    ).toBe(false);
    expect(
      canInspectPlugin(
        { state: "staged", directories: ["plugins/a"] },
        "plugins/a",
      ),
    ).toBe(true);
  });
  it("persists controlled reasons without arbitrary exception text", () => {
    expect(
      pluginImportErrorCode(
        new ApplicationError("PLUGIN_NO_PLUGIN_MANIFEST", "private text", 400),
      ),
    ).toBe("PLUGIN_NO_PLUGIN_MANIFEST");
    expect(pluginImportErrorCode(new Error("PLUGIN_GIT_TIMEOUT"))).toBe(
      "PLUGIN_GIT_TIMEOUT",
    );
    expect(
      pluginImportErrorCode(
        new Error("https://secret.example.test/credential"),
      ),
    ).toBe("IMPORT_FAILED");
    expect(
      pluginImportErrorCode(
        new ApplicationError("arbitrary", "private text", 400),
      ),
    ).toBe("IMPORT_FAILED");
  });
});
