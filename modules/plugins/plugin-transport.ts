import type { ApprovedTool } from "./plugin-types.js";

/**
 * Binary transport capabilities (attachment import, image/file export) are
 * declared by an MCP server under `experimental` and bound to one approved
 * "anchor" tool. The anchor carries the approval, opens the MCP session used
 * for tickets and is re-checked before every transfer.
 *
 * Servers that omit `anchorTool` are sandboxes: the anchor is prepare_sandbox,
 * the workspace is /workspace/ and the full sandbox tool set is required.
 * Servers that name another anchor are generators: only the anchor tool is
 * required and their workspace is a dedicated /workspace/<name>/ prefix.
 */
export const sandboxAnchorTool = "prepare_sandbox";
export const sandboxWorkspacePrefix = "/workspace/";
export const generatorMimeTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export type GeneratorMimeType = (typeof generatorMimeTypes)[number];
export type TransportKind = "sandbox" | "generator";

export interface TransportCapability {
  version: 1;
  anchorTool: string;
  workspacePrefix: string;
  mimeTypes?: GeneratorMimeType[];
}

const toolName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const prefix = /^\/workspace\/[a-z0-9][a-z0-9-]{0,31}\/$/u;

/** Returns null for absent, unsupported or malformed declarations (fail closed). */
export function parseTransportCapability(
  value: unknown,
  options: { mimeTypes?: boolean } = {},
): TransportCapability | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return null;
  if (v.anchorTool === undefined) {
    if (v.workspacePrefix !== undefined || v.mimeTypes !== undefined)
      return null;
    return {
      version: 1,
      anchorTool: sandboxAnchorTool,
      workspacePrefix: sandboxWorkspacePrefix,
    };
  }
  if (
    typeof v.anchorTool !== "string" ||
    !toolName.test(v.anchorTool) ||
    v.anchorTool === sandboxAnchorTool ||
    typeof v.workspacePrefix !== "string" ||
    !prefix.test(v.workspacePrefix)
  )
    return null;
  let mimeTypes: GeneratorMimeType[] | undefined;
  if (options.mimeTypes) {
    if (
      !Array.isArray(v.mimeTypes) ||
      v.mimeTypes.length === 0 ||
      v.mimeTypes.length > generatorMimeTypes.length ||
      new Set(v.mimeTypes).size !== v.mimeTypes.length ||
      !v.mimeTypes.every((m) =>
        (generatorMimeTypes as readonly unknown[]).includes(m),
      )
    )
      return null;
    mimeTypes = v.mimeTypes as GeneratorMimeType[];
  } else if (v.mimeTypes !== undefined) return null;
  return {
    version: 1,
    anchorTool: v.anchorTool,
    workspacePrefix: v.workspacePrefix,
    ...(mimeTypes ? { mimeTypes } : {}),
  };
}

export function transportKind(anchor: ApprovedTool): TransportKind {
  return anchor.definition.name === sandboxAnchorTool ? "sandbox" : "generator";
}

export function transportWorkspacePrefix(anchor: ApprovedTool): string {
  return anchor.transportWorkspacePrefix ?? sandboxWorkspacePrefix;
}

/** Tools that must be approved (and unchanged) for a transport target. */
export function requiredTransportTools(
  anchor: ApprovedTool,
  purpose: "export" | "attachment",
): string[] {
  if (transportKind(anchor) === "generator") return [anchor.definition.name];
  return purpose === "export"
    ? [sandboxAnchorTool, "run_command"]
    : [sandboxAnchorTool, "run_command", "read_file", "write_file"];
}

/** Longest declared workspace prefix wins; sandboxes own the plain /workspace/. */
export function routeWorkspacePath<T extends { workspacePrefix: string }>(
  path: string,
  targets: readonly T[],
): T | undefined {
  return [...targets]
    .filter((t) => path.startsWith(t.workspacePrefix))
    .sort((a, b) => b.workspacePrefix.length - a.workspacePrefix.length)[0];
}
