import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parse as yaml } from "yaml";
import { z } from "zod";
import {
  pluginError,
  pluginLimits,
  type PluginPackage,
  type PluginSkill,
  type PluginServer,
} from "./plugin-types.js";
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function safePath(path: string): string {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path
      .split("/")
      .some((p) =>
        ["..", ".git", "__proto__", "constructor", "prototype"].includes(p),
      )
  )
    pluginError("UNSAFE_PATH");
  return path.replace(/^\.\//, "");
}
const record = z.record(z.string(), z.unknown());
const text = z.string().min(1).max(4096);
export function packageDirectories(files: Record<string, string>): string[] {
  return [
    ...new Set(
      Object.keys(files)
        .filter((p) => p === "plugin.json" || p.endsWith("/plugin.json"))
        .map((p) =>
          p.endsWith(".codex-plugin/plugin.json")
            ? p.slice(0, -".codex-plugin/plugin.json".length)
            : p.slice(0, -"plugin.json".length),
        )
        .map((p) => p.replace(/\/$/, "") || "."),
    ),
  ].sort();
}
function parsePackage(
  all: Record<string, string>,
  directory: string,
): PluginPackage {
  const prefix = directory === "." ? "" : safePath(directory) + "/";
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(all)) {
    safePath(path);
    if (path.startsWith(prefix)) files[path.slice(prefix.length)] = content;
  }
  const portable = files["plugin.json"] !== undefined;
  const manifest = record.parse(
    JSON.parse(
      files[portable ? "plugin.json" : ".codex-plugin/plugin.json"] ?? "null",
    ),
  );
  if (
    portable &&
    manifest.$schema !==
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
  )
    pluginError("UNSUPPORTED_SCHEMA");
  if (!portable && manifest.$schema !== undefined)
    pluginError("UNSUPPORTED_SCHEMA");
  const inline = record.parse(manifest.extensions ?? {})["com.openai"];
  const extension = portable
    ? record.parse(
        inline ??
          (files[".codex-plugin/plugin.json"]
            ? JSON.parse(files[".codex-plugin/plugin.json"])
            : {}),
      )
    : manifest;
  for (const config of [manifest, extension])
    for (const key of [
      "hooks",
      "apps",
      "commands",
      "agents",
      "requires_local_executor",
      "dependencies",
    ])
      if (config[key] !== undefined) pluginError("UNSUPPORTED_COMPONENT");
  const name = z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64)
    .parse(manifest.name);
  const version = z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/)
    .parse(manifest.version);
  if (
    Object.keys(files).some(
      (p) =>
        /^(hooks|scripts)\//.test(p) || /\.(sh|py|mjs|cjs|exe|wasm)$/.test(p),
    )
  )
    pluginError("UNSUPPORTED_COMPONENT");
  const skillsRoot = portable
    ? "skills/"
    : safePath(z.string().parse(manifest.skills ?? "./skills/"));
  for (const [path, content] of Object.entries(files)) {
    if (path === ".gitmodules") pluginError("UNSUPPORTED_COMPONENT");
    if (path.endsWith("agents/openai.yaml")) {
      const config = record.parse(yaml(content));
      if (config.dependencies) pluginError("UNSUPPORTED_SKILL_DEPENDENCY");
    }
  }
  const skills: PluginSkill[] = [];
  for (const path of Object.keys(files).sort()) {
    if (
      !path.startsWith(skillsRoot.replace(/\/$/, "") + "/") ||
      !path.endsWith("/SKILL.md")
    )
      continue;
    const body = files[path]!;
    if (Buffer.byteLength(body) > pluginLimits.textBytes)
      pluginError("SKILL_TOO_LARGE");
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
    if (!match) pluginError("INVALID_SKILL");
    const meta = record.parse(yaml(match[1]!));
    if (
      meta["allowed-tools"] ||
      meta.dependencies ||
      meta["context"] === "fork" ||
      meta.agent
    )
      pluginError("UNSUPPORTED_SKILL_DEPENDENCY");
    // This is a conservative preflight, not an execution permission boundary.
    if (
      /(?:exec_command|node_repl|cua_repl|\b(?:bash|python3?|node|npx|uvx)\s+[^\n]*\.(?:py|sh|js)|scripts\/[^\s]+|\$\{?CODEX_HOME)/i.test(
        body,
      )
    )
      pluginError("UNSUPPORTED_SKILL_RUNTIME");
    const root = posix.dirname(path) + "/";
    const references = Object.keys(files).filter(
      (p) =>
        p.startsWith(root) &&
        p !== path &&
        /\.(md|txt|json|ya?ml|csv)$/i.test(p),
    );
    for (const link of body.matchAll(/\]\(([^)]+)\)/g)) {
      const target = link[1]!.split("#")[0]!;
      if (!target || /^https?:\/\//.test(target)) continue;
      const resolved = safePath(posix.join(root, target));
      if (!files[resolved]) pluginError("MISSING_REFERENCE");
      if (!/\.(md|txt|json|ya?ml|csv)$/i.test(resolved))
        pluginError("UNSUPPORTED_REFERENCE");
      if (!references.includes(resolved)) references.push(resolved);
    }
    skills.push({
      contentHash: digest([body, ...references.map((p) => files[p])]),
      id: path,
      name: text.parse(meta.name),
      description: text.parse(meta.description),
      file: path,
      references,
    });
  }
  const mcpPath = portable
    ? "mcp.json"
    : safePath(z.string().parse(manifest.mcpServers ?? "./.mcp.json"));
  const servers: PluginServer[] = [];
  if (files[mcpPath]) {
    const mcp = record.parse(JSON.parse(files[mcpPath]));
    if (
      portable &&
      mcp.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
    )
      pluginError("UNSUPPORTED_MCP_SCHEMA");
    for (const [name, raw] of Object.entries(record.parse(mcp.mcpServers))) {
      const s = z
        .object({
          type: z.enum(["streamable-http", "http"]).optional(),
          url: z.string().url(),
          headers: z.record(z.string(), z.string()).default({}),
        })
        .strict()
        .parse(raw);
      if (portable && s.type !== "streamable-http")
        pluginError("UNSUPPORTED_TRANSPORT");
      const u = new URL(s.url);
      if (
        !/^https?:$/.test(u.protocol) ||
        u.username ||
        u.password ||
        u.search ||
        u.hash
      )
        pluginError("INVALID_SERVER_URL");
      if (
        Object.values(s.headers).some((v) => !/^\$\{[A-Z][A-Z0-9_]*\}$/.test(v))
      )
        pluginError("EMBEDDED_HEADERS_NOT_SUPPORTED");
      if (Object.keys(s.headers).length > 1)
        pluginError("MULTIPLE_AUTH_HEADERS_NOT_SUPPORTED");
      servers.push({ name, url: s.url, headers: s.headers });
    }
  }
  if (manifest.mcpServers && !files[mcpPath]) pluginError("MISSING_MCP_CONFIG");
  if (new Set(skills.map((s) => s.name)).size !== skills.length)
    pluginError("DUPLICATE_SKILL");
  if (!skills.length && !servers.length) pluginError("EMPTY_PACKAGE");
  if (skills.length + servers.length > pluginLimits.tools)
    pluginError("TOO_MANY_COMPONENTS");
  return {
    name,
    version,
    description: text.parse(manifest.description),
    format: portable ? "portable-1" : "codex",
    skills,
    servers,
    files,
    hash: digest(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function parsePluginPackage(
  all: Record<string, string>,
  directory: string,
): PluginPackage {
  try {
    return parsePackage(all, directory);
  } catch (error) {
    if (error instanceof Error && "code" in error) throw error;
    return pluginError("INVALID_MANIFEST");
  }
}
