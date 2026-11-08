import {
  countBuckets,
  countGroupLimit,
  type CountBucket,
} from "./chat-count-buckets.js";
import type { MessageAuthor } from "../identity/bot-identity.js";
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
  type CountPosition,
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
  if (query.botWorkflowId)
    predicates.push(
      `EXISTS(SELECT 1 FROM message_bot_attributions a WHERE a.message_id=m.id AND a.workflow_id=${parameter(query.botWorkflowId)}::uuid)`,
    );
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
  const attachments = `jsonb_array_elements(CASE WHEN jsonb_typeof(m.attachments)='array' THEN m.attachments ELSE '[]'::jsonb END)`;
  const attachmentConditions: string[] = [];
  if (query.attachmentName)
    attachmentConditions.push(
      `strpos(lower(coalesce(a->>'fileName','')),lower(${parameter(query.attachmentName)}::text))>0`,
    );
  if (query.attachmentType)
    attachmentConditions.push(
      query.attachmentType.startsWith(".")
        ? `right(lower(coalesce(a->>'fileName','')),length(${parameter(query.attachmentType)}::text))=${parameter(query.attachmentType)}::text`
        : `lower(coalesce(a->>'mimeType',''))=${parameter(query.attachmentType)}::text`,
    );
  if (query.hasAttachments !== undefined || attachmentConditions.length)
    predicates.push(
      `${query.hasAttachments === false ? "NOT " : ""}EXISTS(SELECT 1 FROM ${attachments} a${attachmentConditions.length ? ` WHERE ${attachmentConditions.join(" AND ")}` : ""})`,
    );
  if (query.authorKind) {
    const knownBot = `m.is_from_me AND EXISTS(SELECT 1 FROM message_bot_attributions a WHERE a.message_id=m.id)`;
    const participant = `NOT m.is_from_me AND m.sender_id IS NOT NULL`;
    predicates.push(
      query.authorKind === "bot"
        ? `(${knownBot})`
        : query.authorKind === "participant"
          ? `(${participant})`
          : `NOT ((${knownBot}) OR (${participant}))`,
    );
  }
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
  group_author: MessageAuthor | null;
}
export interface ArchiveQueryMessage {
  senderId: string | null;
  message: MemoryMessage;
  position: MessagePosition;
}
export interface ArchiveQueryGroup {
  author: MessageAuthor | null;
  key: string;
  senderId: string | null;
  count: number;
  message: ArchiveQueryMessage | null;
  dimensions?: Record<string, unknown>;
  memberKey?: string;
  position?: CountPosition;
}
export interface ArchivePage<T> {
  queriedAt: string;
  rows: T[];
  totalCount?: number;
  totalGroups?: number;
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
  private async count(
    scope: MemoryScope,
    query: ChatCountQuery,
    timeZone: string,
    after?: string | CountPosition,
    context?: AgentToolContext,
  ): Promise<ArchivePage<ArchiveQueryGroup>> {
    const buckets = countBuckets(query, timeZone);
    const f = chatFilterSql(scope, query, timeZone);
    const bucketParam = f.parameter(JSON.stringify(buckets));
    const senderKey = `CASE WHEN EXISTS(SELECT 1 FROM message_bot_attributions a WHERE a.message_id=m.id) THEN '2'||(SELECT a.workflow_id::text FROM message_bot_attributions a WHERE a.message_id=m.id) WHEN m.is_from_me THEN '0self' WHEN m.sender_id IS NULL THEN '0' ELSE '1'||m.sender_id END`;
    const clock = `m.sent_at AT TIME ZONE ${f.zone}::text`;
    const hour = `lpad(extract(hour FROM ${clock})::int::text,2,'0')`;
    const weekday = `lpad(extract(isodow FROM ${clock})::int::text,2,'0')`;
    const calendar = ["hour", "day", "week", "month"].includes(query.groupBy);
    const primary =
      query.groupBy === "none"
        ? `'all'::text`
        : query.groupBy === "sender"
          ? senderKey
          : query.groupBy === "hourOfDay"
            ? hour
            : query.groupBy === "weekday"
              ? weekday
              : `(SELECT keys FROM bucket_arrays)[width_bucket(m.sent_at,(SELECT starts FROM bucket_arrays))]`;
    const secondary =
      query.breakdownBy === "sender"
        ? senderKey
        : query.breakdownBy === "hourOfDay"
          ? hour
          : `''::text`;
    const dense = query.groupBy !== "sender" && query.breakdownBy !== "sender";
    const keys = !dense
      ? `SELECT pkey,skey FROM aggregated`
      : query.groupBy === "none"
        ? `SELECT 'all'::text AS pkey,''::text AS skey`
        : query.breakdownBy === "hourOfDay"
          ? `SELECT b.key AS pkey,lpad(h::text,2,'0') AS skey FROM buckets b CROSS JOIN generate_series(0,23) h`
          : `SELECT key AS pkey,''::text AS skey FROM buckets`;
    const groupKey = query.breakdownBy
      ? `jsonb_build_array(k.pkey,k.skey)::text`
      : `k.pkey`;
    const descending = query.orderBy === "countDesc";
    const position =
      typeof after === "string" ? { key: after, count: 0 } : after;
    const predicate = position
      ? descending
        ? `(g.count<${f.parameter(position.count)}::bigint OR (g.count=${f.parameter(position.count)}::bigint AND g.key COLLATE "C">${f.parameter(position.key)}::text COLLATE "C"))`
        : `g.key COLLATE "C">${f.parameter(position.key)}::text COLLATE "C"`
      : "TRUE";
    const order = `${descending ? "g.count DESC," : ""}g.key COLLATE "C"`;
    const withMember =
      query.groupBy === "sender" || query.breakdownBy === "sender";
    interface CountRow {
      key: string;
      pkey: string;
      skey: string;
      count: string;
      author: MessageAuthor | null;
    }
    const page = await this.page<{
      total_count: string;
      total_groups: string;
      items: CountRow[];
    }>(
      `WITH buckets AS (SELECT * FROM jsonb_to_recordset(${bucketParam}::jsonb) AS b(key text,start timestamptz)),
      bucket_arrays AS (SELECT array_agg(key ORDER BY start) AS keys,array_agg(start ORDER BY start) AS starts FROM buckets),
      filtered AS MATERIALIZED (SELECT m.id,${primary} AS pkey,${secondary} AS skey FROM messages m WHERE ${f.where} AND ${f.zone}::text IS NOT NULL),
      aggregated AS (SELECT pkey,skey,count(*) AS count,min(id::text)::uuid AS representative FROM filtered GROUP BY pkey,skey),
      keys AS (${keys}),
      groups AS (SELECT ${groupKey} AS key,k.pkey,k.skey,coalesce(a.count,0) AS count,a.representative FROM keys k LEFT JOIN aggregated a ON a.pkey=k.pkey AND a.skey=k.skey),
      stats AS (SELECT (SELECT count(*)::text FROM filtered) AS total_count,(SELECT count(*) FROM (SELECT 1 FROM groups LIMIT ${countGroupLimit + 1}) bounded) AS total_groups),
      selected AS (SELECT g.key,g.pkey,g.skey,g.count::text,${withMember ? "bot_message_author(g.representative)" : "NULL::jsonb"} AS author FROM groups g CROSS JOIN stats s WHERE s.total_groups<=${countGroupLimit} AND ${predicate} ORDER BY ${order} LIMIT ${f.parameter(query.limit + 1)})
      SELECT s.total_count,s.total_groups::text,coalesce((SELECT json_agg(selected) FROM selected),'[]'::json) AS items FROM stats s`,
      f.values,
      context,
    );
    const result = page.rows[0]!;
    const exact = (s: string) => {
      const n = Number(s);
      if (!Number.isSafeInteger(n) || n < 0)
        throw new ChatQueryError("count-out-of-range");
      return n;
    };
    const totalGroups = exact(result.total_groups);
    if (totalGroups > countGroupLimit) throw new ChatQueryError("group-limit");
    const byKey = new Map<string, CountBucket>(buckets.map((b) => [b.key, b]));
    return {
      queriedAt: page.queriedAt,
      totalCount: exact(result.total_count),
      totalGroups,
      rows: result.items.map((row) => {
        const count = exact(row.count);
        const memberKey =
          query.groupBy === "sender"
            ? row.pkey
            : query.breakdownBy === "sender"
              ? row.skey
              : undefined;
        const bucket = byKey.get(row.pkey);
        const dimensions: Record<string, unknown> = {};
        if (query.groupBy === "sender") {
          dimensions.senderId = memberKey?.startsWith("1")
            ? memberKey.slice(1)
            : null;
          dimensions.author = row.author;
        } else if (query.groupBy === "day") dimensions.date = row.pkey;
        else if (query.groupBy !== "none")
          dimensions[query.groupBy] = bucket?.value ?? row.pkey;
        if (calendar && query.groupBy !== "day") {
          dimensions.bucketStart = bucket?.start;
          dimensions.bucketEnd = bucket?.end;
        }
        if (calendar) dimensions.partialBucket = bucket?.partialBucket ?? false;
        if (query.breakdownBy === "sender") dimensions.senderKey = row.skey;
        if (query.breakdownBy === "hourOfDay")
          dimensions.hourOfDay = Number(row.skey);
        return {
          key: row.key,
          count,
          message: null,
          author: row.author,
          senderId: memberKey?.startsWith("1") ? memberKey.slice(1) : null,
          dimensions,
          ...(memberKey === undefined ? {} : { memberKey }),
          position: { key: row.key, count },
        };
      }),
    };
  }

  async aggregate(
    scope: MemoryScope,
    query: ChatCountQuery | ChatExtremaQuery,
    timeZone: string,
    after?: string | CountPosition,
    context?: AgentToolContext,
  ): Promise<ArchivePage<ArchiveQueryGroup>> {
    if (!("pick" in query))
      return this.count(scope, query, timeZone, after, context);
    const f = chatFilterSql(scope, query, timeZone);
    const bounds = query.groupBy === "day" ? dayBounds(query, timeZone) : null;
    const key =
      query.groupBy === "day"
        ? `to_char(m.sent_at AT TIME ZONE ${f.zone}::text,'YYYY-MM-DD')`
        : query.groupBy === "sender"
          ? `CASE WHEN EXISTS(SELECT 1 FROM message_bot_attributions a WHERE a.message_id=m.id) THEN '2'||(SELECT a.workflow_id::text FROM message_bot_attributions a WHERE a.message_id=m.id) WHEN m.is_from_me THEN '0self' WHEN m.sender_id IS NULL THEN '0' ELSE '1'||m.sender_id END`
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
      SELECT k.group_key, ${query.groupBy === "sender" ? "CASE WHEN left(k.group_key,1)='1' THEN substr(k.group_key,2) ELSE NULL END" : "NULL::text"} AS group_sender,
      ${query.groupBy === "sender" ? "(SELECT bot_message_author(f.id) FROM filtered f WHERE f.group_key=k.group_key ORDER BY f.message_index LIMIT 1)" : "NULL::jsonb"} AS group_author,
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
          author: row.group_author,
          senderId: row.group_sender,
          count,
          message: extrema && row.id ? archived(row) : null,
        };
      }),
    };
  }
}
