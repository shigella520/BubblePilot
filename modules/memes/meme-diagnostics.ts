import { z } from "zod";
const requestSchema = z
  .object({
    query: z.string().trim().max(200),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();
const selectionSchema = z.object({ id: z.string().uuid().nullable() }).strict();
const resultSchema = z.object({
  status: z.string(),
  reason: z.string().optional(),
  id: z.string().uuid().nullable().optional(),
  results: z.array(z.unknown()).optional(),
  truncated: z.boolean().optional(),
});
const reasons = new Set([
  "timeout",
  "query-failed",
  "content-budget",
  "not-a-returned-candidate",
  "asset-unavailable",
  "tool-calls",
  "tool-output",
  "tool-duration",
]);
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
/** Only accepted output is inspected; no callbacks can mutate diagnostics after a timeout. */
export function memeDiagnostics(
  name: string,
  args: string,
  content: string,
  errorCode: string | null,
  skipped: boolean,
) {
  const request: Record<string, unknown> = { version: 1, kind: "meme" };
  const response: Record<string, unknown> = { version: 1, kind: "meme" };
  const search = name === "search_memes";
  const input = search
    ? requestSchema.safeParse(parseJson(args))
    : selectionSchema.safeParse(parseJson(args));
  if (search && input.success && "query" in input.data) {
    request.mode = input.data.query ? "keywords" : "browse";
    request.keywordCount = Math.min(
      20,
      new Set(input.data.query.toLowerCase().split(/\s+/u).filter(Boolean))
        .size,
    );
    request.requestedLimit = input.data.limit;
  }
  const parsed = resultSchema.safeParse(parseJson(content));
  const payload = parsed.success ? parsed.data : null;
  let outcome = payload?.status ?? "unavailable";
  let code = errorCode;
  if (errorCode === "AI_AGENT_TOOL_TIMEOUT" || payload?.reason === "timeout")
    outcome = "timeout";
  else if (
    skipped ||
    errorCode === "AI_AGENT_TOOL_LIMIT_REACHED" ||
    ["tool-calls", "tool-output", "tool-duration", "content-budget"].includes(
      payload?.reason ?? "",
    )
  )
    outcome = "budget-exhausted";
  else if (errorCode)
    outcome =
      payload?.status === "invalid-arguments"
        ? "invalid-arguments"
        : "unavailable";
  if (!input.success && !skipped && !errorCode) outcome = "invalid-arguments";
  if (outcome === "selected")
    outcome =
      payload?.id === null
        ? "cleared"
        : payload?.id
          ? "selected"
          : "unavailable";
  if (
    ![
      "ok",
      "no-results",
      "selected",
      "cleared",
      "invalid-selection",
      "invalid-arguments",
      "unavailable",
      "timeout",
      "budget-exhausted",
    ].includes(outcome)
  )
    outcome = "unavailable";
  if (outcome === "invalid-selection") code = "MEME_INVALID_SELECTION";
  if (outcome === "invalid-arguments") code = "AI_AGENT_INVALID_TOOL_ARGUMENTS";
  if (outcome === "unavailable") code ??= "MEME_TOOL_UNAVAILABLE";
  if (outcome === "timeout") code = "AI_AGENT_TOOL_TIMEOUT";
  if (outcome === "budget-exhausted") code = "AI_AGENT_TOOL_LIMIT_REACHED";
  response.outcome = outcome;
  if (payload?.reason && reasons.has(payload.reason))
    response.reason = payload.reason;
  const count =
    search && ["ok", "no-results"].includes(outcome)
      ? (payload?.results?.length ?? 0)
      : null;
  if (count !== null) {
    response.returnedCount = count;
    response.truncated = payload?.truncated ?? false;
  }
  if (outcome === "selected" && payload?.id)
    response.selectedMemeId = payload.id;
  return {
    requestDetails: request,
    responseDetails: response,
    resultCount: count,
    errorCode: code,
  };
}
