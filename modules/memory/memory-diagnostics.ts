import pg from "pg";
import { z } from "zod";
import { EmbeddingError } from "./embedding-client.js";
import { ChatQueryError } from "./chat-query-types.js";

export type MemoryDiagnosticStage =
  | "arguments"
  | "authorization"
  | "validation"
  | "archive-query"
  | "coverage"
  | "embedding-identity"
  | "embedding-query"
  | "keyword-search"
  | "vector-search"
  | "source-read"
  | "source-validation"
  | "output-fitting"
  | "record-sources"
  | "timeout";

export interface MemoryFailureDiagnostic {
  stage: MemoryDiagnosticStage;
  category:
    | "invalid-json"
    | "invalid-arguments"
    | "embedding-error"
    | "database-error"
    | "query-error"
    | "timeout"
    | "internal-error";
  validationIssues?: { field?: string; code: string }[];
  errorCode?: string;
  httpStatus?: number;
}

export interface MemoryToolDiagnostic {
  kind: "memory";
  version: 1;
  status?: "succeeded" | "partial" | "no-results" | "unavailable";
  mode?: "hybrid" | "keyword-only";
  reason?: string;
  failure?: MemoryFailureDiagnostic;
  embeddingFallback?: MemoryFailureDiagnostic;
  keywordFailure?: MemoryFailureDiagnostic;
}

const fields = new Set([
  "query",
  "limit",
  "from",
  "to",
  "senderId",
  "botWorkflowId",
  "ref",
  "before",
  "after",
  "attachmentOffset",
  "cursor",
  "order",
  "groupBy",
  "breakdownBy",
  "orderBy",
  "pick",
  "dailyTime",
]);
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
const embeddingCodes = new Set([
  "MEMORY_MODEL_CHANGED",
  "MEMORY_MODEL_IDENTITY_UNAVAILABLE",
  "MEMORY_EMBEDDING_HTTP_ERROR",
  "MEMORY_EMBEDDING_EMPTY",
  "MEMORY_EMBEDDING_TOO_LARGE",
  "MEMORY_EMBEDDING_UNAVAILABLE",
  "MEMORY_EMBEDDING_INPUT_INVALID",
  "MEMORY_EMBEDDING_INVALID_OUTPUT",
  "MEMORY_EMBEDDING_INVALID_ORDER",
]);
const reasons = new Set([
  "source-unavailable",
  "invalid-or-unavailable",
  "invalid-arguments",
  "reference-unavailable",
  "query-failed",
  "retrieval-unavailable",
  "invalid-cursor",
  "tool-output",
  "tool-duration",
  "day-range-too-large",
  "day-range-required",
  "count-out-of-range",
]);

/** Never retain raw errors, inputs, validation messages, or untrusted field names. */
export function memoryFailureDiagnostic(
  stage: MemoryDiagnosticStage,
  error: unknown,
): MemoryFailureDiagnostic {
  if (error instanceof z.ZodError) {
    return {
      stage,
      category: "invalid-arguments",
      validationIssues: error.issues.slice(0, 5).map((issue) => {
        const field = issue.path.find(
          (part): part is string =>
            typeof part === "string" && fields.has(part),
        );
        return {
          ...(field ? { field } : {}),
          code: issueCodes.has(issue.code) ? issue.code : "other",
        };
      }),
    };
  }
  if (stage === "arguments" && error instanceof SyntaxError)
    return { stage, category: "invalid-json" };
  if (error instanceof ChatQueryError)
    return { stage, category: "query-error" };
  if (error instanceof EmbeddingError)
    return {
      stage,
      category: "embedding-error",
      ...(embeddingCodes.has(error.code) ? { errorCode: error.code } : {}),
      ...(Number.isInteger(error.httpStatus) &&
      error.httpStatus !== undefined &&
      error.httpStatus >= 100 &&
      error.httpStatus <= 599
        ? { httpStatus: error.httpStatus }
        : {}),
    };
  if (error instanceof pg.DatabaseError)
    return {
      stage,
      category: "database-error",
      ...(typeof error.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code)
        ? { errorCode: error.code }
        : {}),
    };
  return { stage, category: "internal-error" };
}

export function memoryResultDiagnostic(
  content: string,
  details: {
    failure?: MemoryFailureDiagnostic;
    embeddingFallback?: MemoryFailureDiagnostic;
    keywordFailure?: MemoryFailureDiagnostic;
  } = {},
): MemoryToolDiagnostic {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      value = parsed as Record<string, unknown>;
  } catch {
    // Never copy raw content into the diagnostic.
  }
  const status = value.status;
  const mode = value.retrievalMode;
  return {
    kind: "memory",
    version: 1,
    ...(status === "succeeded" ||
    status === "partial" ||
    status === "no-results" ||
    status === "unavailable"
      ? { status }
      : {}),
    ...(mode === "hybrid" || mode === "keyword-only" ? { mode } : {}),
    ...(typeof value.reason === "string" && reasons.has(value.reason)
      ? { reason: value.reason }
      : {}),
    ...details,
  };
}
