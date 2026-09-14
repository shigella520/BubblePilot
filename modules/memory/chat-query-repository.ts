import { AgentToolTimeout, type AgentToolContext } from "../ai/agent-budget.js";
import type { Pool } from "pg";
import {
  messageColumns,
  memoryMessage,
  type MessageRow,
} from "./archive-message.js";
import type { MemoryMessage } from "./chunking.js";
import type { MemoryScope } from "./memory-types.js";
import {
  ChatQueryError,
  dayBounds,
  type ChatFilters,
  type ChatMessageQuery,
  type ChatCountQuery,
  type ChatExtremaQuery,
  type MessagePosition,
} from "./chat-query-types.js";

/** All raw queries and aggregates use exactly these predicates, before LIMIT. */
export function chatFilterSql(
  scope: MemoryScope,
  query: ChatFilters,
  timeZone: string,
) {
  const values: unknown[] = [];
  const parameter = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const predicates = [
    `m.chat_id=${parameter(scope.chatId)}::uuid`,
    `m.message_index<${parameter(scope.upperIndex)}::bigint`,
    "m.content_redacted_at IS NULL",
  ];
  if (query.senderId !== undefined)
    predicates.push(`m.sender_id=${parameter(query.senderId)}::text`);
  if (query.from)
    predicates.push(`m.sent_at>=${parameter(query.from)}::timestamptz`);
  if (query.to)
    predicates.push(`m.sent_at<=${parameter(query.to)}::timestamptz`);
  const zone = parameter(timeZone);
  if (query.dailyTime) {
    const clock = `(m.sent_at AT TIME ZONE ${zone}::text)::time`;
    const from = parameter(query.dailyTime.from),
      to = parameter(query.dailyTime.to);
    predicates.push(
      `(${clock}>=${from}::time ${query.dailyTime.from < query.dailyTime.to ? "AND" : "OR"} ${clock}<${to}::time)`,
    );
  }
  if (query.keywords)
    predicates.push(
      `(${query.keywords.map((word) => `strpos(lower(coalesce(m.body,'')),lower(${parameter(word)}::text))>0`).join(query.keywordMode === "all" ? " AND " : " OR ")})`,
    );
  return { values, parameter, where: predicates.join(" AND "), zone };
}
const exactTime = `to_char(m.sent_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
interface QueryMessageRow extends MessageRow {
  sort_time: string;
}
interface GroupRow extends QueryMessageRow {
  group_key: string;
  count: string;
  group_sender: string | null;
}
export interface ArchiveQueryMessage {
  senderId: string | null;
  message: MemoryMessage;
  position: MessagePosition;
}
export interface ArchiveQueryGroup {
  key: string;
  senderId: string | null;
  count: number;
  message: ArchiveQueryMessage | null;
}
export interface ArchivePage<T> {
  queriedAt: string;
  rows: T[];
}
function archived(row: QueryMessageRow): ArchiveQueryMessage {
  return {
    senderId: row.sender_id,
    message: memoryMessage(row),
    position: { sentAt: row.sort_time, index: String(row.message_index) },
  };
}
export class ChatQueryRepository {
  constructor(private readonly pool: Pool) {}
  private async page<T>(
    sql: string,
    values: unknown[],
    context?: AgentToolContext,
  ): Promise<ArchivePage<T>> {
    const client = await this.pool.connect();
    let released = false;
    const cancel = () => {
      if (!released) {
        released = true;
        client.release(true);
      }
    };
    const check = () => {
      if (
        context?.signal.aborted ||
        Date.now() >= (context?.deadline ?? Infinity)
      )
        throw new AgentToolTimeout();
    };
    context?.signal.addEventListener("abort", cancel, { once: true });
    try {
      check();
      await client.query("BEGIN READ ONLY");
      check();
      await client.query("SELECT set_config('statement_timeout',$1,true)", [
        String(
          Math.max(
            1,
            Math.min(5000, (context?.deadline ?? Infinity) - Date.now()),
          ),
        ),
      ]);
      check();
      const result = await client.query<{ queried_at: Date; rows: T[] }>(
        `WITH page AS (${sql}) SELECT statement_timestamp() AS queried_at, (SELECT coalesce(json_agg(page),'[]'::json) FROM page) AS rows`,
        values,
      );
      check();
      await client.query("COMMIT");
      check();
      const row = result.rows[0];
      if (!row) throw new ChatQueryError("query-failed");
      return { queriedAt: row.queried_at.toISOString(), rows: row.rows };
    } catch (error) {
      if (!released) await client.query("ROLLBACK");
      throw error;
    } finally {
      context?.signal.removeEventListener("abort", cancel);
      if (!released) client.release();
    }
  }
  async query(
    scope: MemoryScope,
    query: ChatMessageQuery,
    timeZone: string,
    after?: MessagePosition,
    context?: AgentToolContext,
  ): Promise<ArchivePage<ArchiveQueryMessage>> {
    const filter = chatFilterSql(scope, query, timeZone);
    const direction = query.order === "asc" ? "ASC" : "DESC";
    let where = filter.where;
    // Keep the zone parameter typed even when there is no daily-time predicate.
    where += ` AND ${filter.zone}::text IS NOT NULL`;
    if (after)
      where += ` AND (m.sent_at,m.message_index) ${query.order === "asc" ? ">" : "<"} (${filter.parameter(after.sentAt)}::timestamptz,${filter.parameter(after.index)}::bigint)`;
    const page = await this.page<QueryMessageRow>(
      `SELECT ${messageColumns.replace("m.message_index", "m.message_index::text AS message_index")}, ${exactTime} AS sort_time FROM messages m WHERE ${where} ORDER BY m.sent_at ${direction},m.message_index ${direction} LIMIT ${filter.parameter(query.limit + 1)}`,
      filter.values,
      context,
    );
    return { ...page, rows: page.rows.map(archived) };
  }
  async aggregate(
    scope: MemoryScope,
    query: ChatCountQuery | ChatExtremaQuery,
    timeZone: string,
    after?: string,
    context?: AgentToolContext,
  ): Promise<ArchivePage<ArchiveQueryGroup>> {
    const f = chatFilterSql(scope, query, timeZone);
    const bounds = query.groupBy === "day" ? dayBounds(query, timeZone) : null;
    const key =
      query.groupBy === "day"
        ? `to_char(m.sent_at AT TIME ZONE ${f.zone}::text,'YYYY-MM-DD')`
        : query.groupBy === "sender"
          ? `CASE WHEN m.sender_id IS NULL THEN '0' ELSE '1'||m.sender_id END`
          : `'all'::text`;
    const keys = bounds
      ? `SELECT to_char(d,'YYYY-MM-DD') AS group_key FROM generate_series(${f.parameter(bounds[0])}::timestamp,${f.parameter(bounds[1])}::timestamp,interval '1 day') d`
      : query.groupBy === "none"
        ? `SELECT 'all'::text AS group_key`
        : `SELECT DISTINCT group_key FROM filtered`;
    const extrema = "pick" in query;
    const order = extrema && query.pick === "last" ? "DESC" : "ASC";
    const aggregated = extrema
      ? `SELECT id,group_key FROM (SELECT id,group_key,row_number() OVER(PARTITION BY group_key ORDER BY sent_at ${order},message_index ${order}) AS rank FROM filtered) r WHERE rank=1`
      : `SELECT group_key,count(*)::text AS count FROM filtered GROUP BY group_key`;
    const condition =
      after === undefined
        ? "TRUE"
        : `k.group_key COLLATE "C">${f.parameter(after)}::text COLLATE "C"`;
    const page = await this.page<GroupRow>(
      `WITH filtered AS (SELECT m.id,m.sent_at,m.message_index,${key} AS group_key FROM messages m WHERE ${f.where} AND ${f.zone}::text IS NOT NULL), keys AS (${keys}), aggregated AS (${aggregated})
      SELECT k.group_key, ${query.groupBy === "sender" ? "CASE WHEN k.group_key='0' THEN NULL ELSE substr(k.group_key,2) END" : "NULL::text"} AS group_sender,
      ${extrema ? `NULL::text AS count,${messageColumns.replace("m.message_index", "m.message_index::text AS message_index")},${exactTime} AS sort_time` : "coalesce(a.count,'0') AS count"}
      FROM keys k LEFT JOIN aggregated a ON a.group_key=k.group_key ${extrema ? "LEFT JOIN messages m ON m.id=a.id" : ""}
      WHERE ${condition} ORDER BY k.group_key COLLATE "C" LIMIT ${f.parameter(query.groupBy === "none" ? 1 : query.limit + 1)}`,
      f.values,
      context,
    );
    return {
      ...page,
      rows: page.rows.map((row) => {
        const count = Number(row.count ?? 0);
        if (!Number.isSafeInteger(count))
          throw new ChatQueryError("count-out-of-range");
        return {
          key: row.group_key,
          senderId: row.group_sender,
          count,
          message: extrema && row.id ? archived(row) : null,
        };
      }),
    };
  }
}
