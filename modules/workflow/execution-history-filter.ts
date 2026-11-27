import type { QueryResultRow } from "pg";

interface Queryable {
  query<R extends QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/**
 * The history boundary of one execution, read once, so set queries can use a
 * plain range predicate instead of calling `execution_history_allows()` (three
 * primary-key lookups) for every candidate row. Each variant mirrors one branch
 * of the SQL function in migrations/0077 (include_current = false); anything
 * the function would treat differently from these shapes stays on the function.
 */
export type ExecutionHistoryBoundary =
  | { kind: "unrestricted" }
  | { kind: "denied" }
  | {
      kind: "sent-time";
      chatId: string;
      provider: string;
      upperIndex: string;
      beforeSentAt: string;
      triggerIndex: string;
    }
  | { kind: "arrival"; chatId: string; provider: string; triggerIndex: string }
  | { kind: "window"; chatId: string; upperIndex: string }
  | { kind: "function"; executionId: string };

const integer = /^-?\d{1,18}$/;
// Exactly the format written by freeze_execution_history().
const frozenTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export async function readExecutionHistoryBoundary(
  db: Queryable,
  executionId: string | null | undefined,
): Promise<ExecutionHistoryBoundary> {
  if (executionId === null || executionId === undefined)
    return { kind: "unrestricted" };
  // Evaluate the JSON operators in SQL so NULL, non-object and missing-key
  // cases behave exactly as they do inside execution_history_allows().
  const row = (
    await db.query<{
      has_trigger: boolean;
      trigger_chat_id: string | null;
      trigger_provider: string | null;
      trigger_index: string | null;
      sent_time: boolean | null;
      upper_index: string | null;
      before_sent_at: string | null;
      boundary_trigger_index: string | null;
      target_chat_id: string | null;
      window_trigger: boolean | null;
      window_upper_index: string | null;
    }>(
      `SELECT t.id IS NOT NULL AS has_trigger,t.chat_id AS trigger_chat_id,t.provider AS trigger_provider,
         t.message_index::text AS trigger_index,
         e.history_boundary ? 'upperIndex' AS sent_time,
         e.history_boundary->>'upperIndex' AS upper_index,
         e.history_boundary->>'beforeSentAt' AS before_sent_at,
         e.history_boundary->>'triggerIndex' AS boundary_trigger_index,
         e.target_chat_id,
         e.trigger_event->>'schemaVersion' IN ('chat-idle-v1','scheduled-task-v1','scheduled-task-v2') AS window_trigger,
         COALESCE(e.trigger_event->'idle'->>'upperMessageIndex',e.trigger_event->'scheduled'->>'upperMessageIndex') AS window_upper_index
       FROM workflow_executions e LEFT JOIN messages t ON t.id=e.source_message_id
       WHERE e.id=$1::uuid`,
      [executionId],
    )
  ).rows[0];
  if (!row) return { kind: "denied" };
  const fallback = { kind: "function", executionId } as const;
  if (row.has_trigger) {
    const chatId = row.trigger_chat_id!,
      provider = row.trigger_provider!;
    if (row.sent_time !== true)
      return {
        kind: "arrival",
        chatId,
        provider,
        triggerIndex: row.trigger_index!,
      };
    const { upper_index, before_sent_at, boundary_trigger_index } = row;
    return upper_index !== null &&
      integer.test(upper_index) &&
      boundary_trigger_index !== null &&
      integer.test(boundary_trigger_index) &&
      before_sent_at !== null &&
      frozenTimestamp.test(before_sent_at)
      ? {
          kind: "sent-time",
          chatId,
          provider,
          upperIndex: upper_index,
          beforeSentAt: before_sent_at,
          triggerIndex: boundary_trigger_index,
        }
      : fallback;
  }
  if (
    row.window_trigger !== true ||
    row.target_chat_id === null ||
    row.window_upper_index === null
  )
    return { kind: "denied" };
  return integer.test(row.window_upper_index)
    ? {
        kind: "window",
        chatId: row.target_chat_id,
        upperIndex: row.window_upper_index,
      }
    : fallback;
}

/**
 * Render the boundary as a predicate over message alias `alias`. `param`
 * appends a value and returns its placeholder (for example `$7`). Equivalent to
 * `execution_history_allows(execution, alias.id)`, but index-friendly.
 */
export function executionHistoryPredicate(
  boundary: ExecutionHistoryBoundary,
  alias: string,
  param: (value: unknown) => string,
): string {
  const m = alias;
  switch (boundary.kind) {
    case "unrestricted":
      return "true";
    case "denied":
      return "false";
    case "sent-time":
      return `(${m}.chat_id=${param(boundary.chatId)}::uuid AND ${m}.provider=${param(boundary.provider)}::text
        AND ${m}.message_index<${param(boundary.upperIndex)}::bigint
        AND (${m}.sent_at,${m}.message_index)<(${param(boundary.beforeSentAt)}::timestamptz,${param(boundary.triggerIndex)}::bigint))`;
    case "arrival":
      return `(${m}.chat_id=${param(boundary.chatId)}::uuid AND ${m}.provider=${param(boundary.provider)}::text
        AND ${m}.message_index<${param(boundary.triggerIndex)}::bigint)`;
    case "window":
      return `(${m}.chat_id=${param(boundary.chatId)}::uuid AND ${m}.message_index<${param(boundary.upperIndex)}::bigint)`;
    case "function":
      return `execution_history_allows(${param(boundary.executionId)}::uuid,${m}.id)`;
  }
}

/** Append a history predicate to an existing positional parameter list. */
export function withExecutionHistory(
  values: readonly unknown[],
  boundary: ExecutionHistoryBoundary,
  alias = "m",
): { sql: string; values: unknown[] } {
  const all = [...values];
  const sql = executionHistoryPredicate(boundary, alias, (value) => {
    all.push(value);
    return `$${all.length}`;
  });
  return { sql, values: all };
}
