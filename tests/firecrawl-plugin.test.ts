import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parsePluginPackage,
  packageDirectories,
} from "../modules/plugins/plugin-package.js";
import { unpackZip } from "../modules/plugins/plugin-storage.js";
import { pluginZip } from "./support/plugin-zip.js";

async function packageFiles() {
  const root = new URL("../plugins/firecrawl/", import.meta.url);
  const files: Record<string, string> = {};
  async function walk(path: string) {
    for (const item of await readdir(new URL(path, root), {
      withFileTypes: true,
    })) {
      const name = path + item.name;
      if (item.isDirectory()) await walk(name + "/");
      else files[name] = await readFile(new URL(name, root), "utf8");
    }
  }
  await walk("");
  return files;
}

describe("maintained Firecrawl package", () => {
  it("imports its actual ZIP through the production parser with a remote secret binding", async () => {
    const files = await packageFiles();
    const extracted = await unpackZip(pluginZip(files));
    expect(packageDirectories(extracted)).toEqual(["."]);
    const pkg = parsePluginPackage(extracted, ".");
    expect(pkg.name).toBe("bubblepilot-firecrawl");
    expect(pkg.servers).toEqual([
      {
        name: "firecrawl",
        url: "https://mcp.firecrawl.dev/v2/mcp",
        headers: { Authorization: "${FIRECRAWL_API_KEY}" },
      },
    ]);
    expect(pkg.skills).toHaveLength(1);
    expect(pkg.skills[0]?.references).toEqual([
      "skills/read-public-page/references.md",
    ]);
    expect(pkg.hash).toBe(parsePluginPackage(files, ".").hash);
  });
});
