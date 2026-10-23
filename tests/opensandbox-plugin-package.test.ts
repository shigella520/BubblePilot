import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parsePluginPackage } from "../modules/plugins/plugin-package.js";
it("imports only the declarative OpenSandbox subdirectory", () => {
  const files = Object.fromEntries(
    ["plugin.json", "mcp.json", "skills/opensandbox/SKILL.md"].map((path) => [
      path,
      readFileSync(
        new URL(`../plugins/opensandbox/plugin/${path}`, import.meta.url),
        "utf8",
      ),
    ]),
  );
  const result = parsePluginPackage(files, ".");
  expect(result.name).toBe("bubblepilot-opensandbox");
  expect(result.skills).toHaveLength(1);
  expect(result.servers).toHaveLength(1);
});
