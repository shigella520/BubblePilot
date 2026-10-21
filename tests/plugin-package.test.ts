import { describe, it, expect } from "vitest";
import {
  parsePluginPackage,
  packageDirectories,
  safePath,
} from "../modules/plugins/plugin-package.js";
import {
  privateAddress,
  resolveTarget,
} from "../modules/plugins/plugin-network.js";
const manifest = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "fictional",
  version: "1.0.0",
  description: "fictional test",
};
export function fixture() {
  return {
    "plugin.json": JSON.stringify(manifest),
    "skills/demo/SKILL.md":
      "---\nname: demo\ndescription: Fictional test skill\n---\nRead [reference](reference.md).",
    "skills/demo/reference.md": "Fictional source.",
  };
}
describe("declarative plugin packages", () => {
  it("discovers nested portable and compatibility packages", () => {
    expect(
      packageDirectories({
        "plugins/a/plugin.json": "{}",
        "plugins/b/.codex-plugin/plugin.json": "{}",
      }),
    ).toEqual(["plugins/a", "plugins/b"]);
  });
  it("parses skill and reference with stable digest", () => {
    const p = parsePluginPackage(fixture(), ".");
    expect(p.skills[0]?.references).toEqual(["skills/demo/reference.md"]);
    expect(p.hash).toBe(parsePluginPackage(fixture(), ".").hash);
  });
  it("accepts the compatibility manifest", () => {
    const files = fixture() as Record<string, string>;
    delete files["plugin.json"];
    files[".codex-plugin/plugin.json"] = JSON.stringify({
      name: "fictional",
      version: "1.0.0",
      description: "Test",
      skills: "./skills/",
    });
    expect(parsePluginPackage(files, ".").format).toBe("codex");
  });
  it.each([
    "../secret",
    "/etc/passwd",
    "a/../../x",
    "x\\y",
    "C:/data",
    "a/__proto__/b",
  ])("rejects unsafe path %s", (p) => expect(() => safePath(p)).toThrow());
  it.each(["hooks", "apps", "commands", "agents", "requires_local_executor"])(
    "rejects %s",
    (key) => {
      const f = fixture();
      f["plugin.json"] = JSON.stringify({ ...manifest, [key]: {} });
      expect(() => parsePluginPackage(f, ".")).toThrow();
    },
  );
  it("rejects unknown schema", () => {
    const f = fixture();
    f["plugin.json"] = JSON.stringify({
      ...manifest,
      $schema: "https://example.test/schema",
    });
    expect(() => parsePluginPackage(f, ".")).toThrow();
  });
  it("rejects missing references", () => {
    const f = fixture();
    delete (f as Record<string, string>)["skills/demo/reference.md"];
    expect(() => parsePluginPackage(f, ".")).toThrow();
  });
  it("does not merge a shadow overlay when inline extension exists", () => {
    const f: Record<string, string> = fixture();
    f["plugin.json"] = JSON.stringify({
      ...manifest,
      extensions: { "com.openai": {} },
    });
    f[".codex-plugin/plugin.json"] = '{"hooks":{}}';
    expect(parsePluginPackage(f, ".").name).toBe("fictional");
  });
  it("rejects stdio and embedded credentials", () => {
    for (const s of [
      { command: "sh" },
      {
        type: "streamable-http",
        url: "https://example.test/mcp",
        headers: { Authorization: "${TOKEN}", "X-Api-Key": "${KEY}" },
      },
      { url: "https://user:password@example.test/mcp" },
      {
        type: "streamable-http",
        url: "https://example.test/mcp",
        headers: { Authorization: "secret" },
      },
    ]) {
      const f: Record<string, string> = fixture();
      f["mcp.json"] = JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { test: s },
      });
      expect(() => parsePluginPackage(f, ".")).toThrow();
    }
  });
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
  ])("classifies private addresses %s", (ip) =>
    expect(privateAddress(ip)).toBe(true),
  );
  it("requires explicit private target approval", async () => {
    await expect(
      resolveTarget("http://127.0.0.1:8123/mcp", false),
    ).rejects.toThrow();
    expect((await resolveTarget("http://127.0.0.1:8123/mcp", true)).host).toBe(
      "127.0.0.1",
    );
  });
});
