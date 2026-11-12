import { chatCountQuerySchema } from "./chat-query-types.js";

/** Allow-list only; never persist dates, keywords, actor IDs, counts or bodies. */
export function chatCountDiagnostics(args: string, content: string) {
  let input: unknown,
    output: Record<string, unknown> = {};
  try {
    input = JSON.parse(args);
  } catch {
    /* invalid arguments stay anonymous */
  }
  try {
    const value: unknown = JSON.parse(content);
    if (value && typeof value === "object" && !Array.isArray(value))
      output = value as Record<string, unknown>;
  } catch {
    /* no raw text */
  }
  const parsed = chatCountQuerySchema.safeParse(input);
  const reason = [
    "tool-output",
    "tool-duration",
    "tool-calls",
    "group-limit",
    "day-range-too-large",
    "day-range-required",
    "invalid-cursor",
    "source-unavailable",
    "count-out-of-range",
    "invalid-or-unavailable",
    "invalid-tool-arguments",
    "query-failed",
    "final-answer-required",
  ].includes(String(output.reason))
    ? String(output.reason)
    : undefined;
  return {
    version: 1,
    metadataOnly: true,
    ...(parsed.success
      ? {
          groupBy: parsed.data.groupBy,
          breakdownBy: parsed.data.breakdownBy,
          orderBy: parsed.data.orderBy ?? "group",
        }
      : {}),
    returnedGroupCount: Array.isArray(output.groups) ? output.groups.length : 0,
    ...(typeof output.hasMore === "boolean" ? { hasMore: output.hasMore } : {}),
    ...(typeof output.truncated === "boolean"
      ? { truncated: output.truncated }
      : {}),
    outputCharacters: content.length,
    ...(reason ? { reason } : {}),
  };
}
