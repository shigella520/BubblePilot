import { z } from "zod";

export interface ToolArgumentIssue {
  field?: string;
  code: string;
  expected?: string;
  minimum?: number;
  maximum?: number;
  guidance?: string;
}

const issueCodes = new Set([
  "invalid_type",
  "too_big",
  "too_small",
  "invalid_format",
  "invalid_value",
  "unrecognized_keys",
  "invalid_union",
  "custom",
]);
const expectedTypes = new Set([
  "string",
  "number",
  "int",
  "boolean",
  "array",
  "object",
  "null",
]);

/** Only names already exposed by the tool schema and explicitly trusted rules may be returned. */
export function toolArgumentIssues(
  error: unknown,
  schema: Record<string, unknown>,
  trustedRules: readonly string[] = [],
): ToolArgumentIssue[] | null {
  if (error instanceof SyntaxError) return [{ code: "invalid_json" }];
  if (!(error instanceof z.ZodError)) return null;
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const object = value as Record<string, unknown>;
    if (object.properties && typeof object.properties === "object") {
      for (const [key, child] of Object.entries(object.properties)) {
        names.add(key);
        visit(child);
      }
    }
    if (Array.isArray(object.anyOf)) object.anyOf.forEach(visit);
    if (Array.isArray(object.oneOf)) object.oneOf.forEach(visit);
    visit(object.items);
  };
  visit(schema);
  const roots = new Set(Object.keys(schema.properties ?? {}));
  return error.issues.slice(0, 8).map((issue) => {
    const path = issue.path;
    const safePath =
      typeof path[0] === "string" &&
      roots.has(path[0]) &&
      path.every(
        (part) =>
          (typeof part === "string" && names.has(part)) ||
          (typeof part === "number" && part >= 0 && part <= 10000),
      )
        ? path.join(".")
        : undefined;
    const detail: ToolArgumentIssue = {
      ...(safePath ? { field: safePath } : {}),
      code: issueCodes.has(issue.code) ? issue.code : "invalid",
    };
    if (
      issue.code === "invalid_type" &&
      typeof issue.expected === "string" &&
      expectedTypes.has(issue.expected)
    )
      detail.expected = issue.expected;
    if (issue.code === "too_small" && typeof issue.minimum === "number")
      detail.minimum = issue.minimum;
    if (issue.code === "too_big" && typeof issue.maximum === "number")
      detail.maximum = issue.maximum;
    if (issue.code === "invalid_format") {
      if (issue.format === "datetime")
        detail.guidance =
          "Use a complete ISO timestamp with seconds and timezone, such as 2026-11-16T09:00:00+08:00.";
      else if (issue.format === "uuid")
        detail.guidance = "Use the exact UUID supplied by the application.";
      else detail.guidance = "Use the format specified in the tool schema.";
    }
    if (issue.code === "custom" && trustedRules.includes(issue.message))
      detail.guidance = issue.message;
    return detail;
  });
}
