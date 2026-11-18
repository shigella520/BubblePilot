import { digest } from "./plugin-package.js";
import type { ApprovedTool } from "./plugin-types.js";

/** Object order is not JSON Schema semantics; array order and schema values are retained. */
export function canonicalToolValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalToolValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalToolValue(item)]),
    );
  return value;
}
function contract(tool: ApprovedTool) {
  return canonicalToolValue({
    server: tool.server,
    definition: {
      ...tool.definition,
      description: tool.definition.description.trim(),
    },
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.imageExportVersion
      ? { imageExportVersion: tool.imageExportVersion }
      : {}),
    ...(tool.attachmentTransferVersion
      ? { attachmentTransferVersion: tool.attachmentTransferVersion }
      : {}),
  });
}
export function toolContractHash(tool: ApprovedTool): string {
  return digest(contract(tool));
}
export interface ToolChange {
  tool: string;
  kind: "unchanged" | "format" | "compatible" | "review";
  paths: string[];
  before: string;
  after: string | null;
}
function equal(a: unknown, b: unknown) {
  return (
    JSON.stringify(canonicalToolValue(a)) ===
    JSON.stringify(canonicalToolValue(b))
  );
}
function paths(a: unknown, b: unknown, path = ""): string[] {
  if (equal(a, b)) return [];
  if (
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const x = a as Record<string, unknown>,
      y = b as Record<string, unknown>;
    return [...new Set([...Object.keys(x), ...Object.keys(y)])].flatMap((key) =>
      paths(
        x[key],
        y[key],
        `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      ),
    );
  }
  return [path || "/"];
}
export function compareTools(
  old: ApprovedTool,
  next?: ApprovedTool,
): ToolChange {
  const result: ToolChange = {
    tool: `${old.server}/${old.definition.name}`,
    kind: "review",
    paths: next
      ? paths(contract(old), contract(next))
          .slice(0, 30)
          .map((p) => p.slice(0, 300))
      : ["/removed"],
    before: toolContractHash(old),
    after: next ? toolContractHash(next) : null,
  };
  if (!next) return result;
  if (result.before === result.after) {
    result.kind = old.hash === next.hash ? "unchanged" : "format";
    if (result.kind === "format") result.paths = ["/format"];
    return result;
  }
  const a = old.definition.parameters,
    b = next.definition.parameters;
  // Deliberately narrow: no refs, composition, dependent constraints or implicit extra properties.
  const allowed = new Set([
    "$schema",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "title",
    "description",
  ]);
  if (
    a.type !== "object" ||
    b.type !== "object" ||
    a.additionalProperties !== false ||
    Object.keys(a).some((k) => !allowed.has(k)) ||
    Object.keys(b).some((k) => !allowed.has(k))
  )
    return result;
  const ap = a.properties as Record<string, unknown> | undefined;
  const bp = b.properties as Record<string, unknown> | undefined;
  if (!ap || !bp || Array.isArray(ap) || Array.isArray(bp)) return result;
  const added = Object.keys(bp).filter((k) => !Object.hasOwn(ap, k));
  if (
    !added.length ||
    added.some((k) => Array.isArray(b.required) && b.required.includes(k))
  )
    return result;
  const reduced = {
    ...next,
    definition: {
      ...next.definition,
      parameters: {
        ...b,
        properties: Object.fromEntries(
          Object.entries(bp).filter(([k]) => !added.includes(k)),
        ),
      },
    },
  };
  if (toolContractHash(old) === toolContractHash(reduced))
    result.kind = "compatible";
  return result;
}
export interface ToolSyncRecord {
  checkedAt: string;
  source: "scheduled" | "call";
  status: "unchanged" | "updated" | "review" | "failed";
  changes: ToolChange[];
  errorCode?: string;
}
