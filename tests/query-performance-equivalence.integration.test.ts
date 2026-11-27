import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresAiRepository,
  aiUsagePeriodSql,
} from "../modules/ai/postgres-ai-repository.js";
import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import { ConversationContextService } from "../modules/workflow/conversation-context-service.js";
import {
  readExecutionHistoryBoundary,
  withExecutionHistory,
} from "../modules/workflow/execution-history-filter.js";
import { PostgresWorkflowRepository } from "../modules/workflow/postgres-workflow-repository.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";

const url = process.env.TEST_DATABASE_URL;

/** Former SQL, kept verbatim to prove the rewrites return identical rows. */
const legacyUsagePeriodSql = `WITH bounds AS (
   SELECT
     date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2 AS today_start,
     date_trunc('week', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2 AS week_start,
     date_trunc('month', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2 AS month_start
 ), periods(period, starts_at) AS (
   SELECT 'today', today_start FROM bounds
   UNION ALL SELECT 'week', week_start FROM bounds
   UNION ALL SELECT 'month', month_start FROM bounds
 )
 SELECT
   p.id AS provider_id, p.name AS provider_name, periods.period,
   COUNT(a.id)::text AS request_count,
   COUNT(a.id) FILTER (WHERE a.status = 'succeeded')::text AS succeeded_request_count,
   COUNT(a.id) FILTER (WHERE a.status = 'failed')::text AS failed_request_count,
   COALESCE(SUM(a.prompt_tokens), 0)::text AS prompt_tokens,
   COALESCE(SUM(a.completion_tokens), 0)::text AS completion_tokens,
   COALESCE(SUM(a.reasoning_tokens), 0)::text AS reasoning_tokens,
   COALESCE(SUM(COALESCE(a.total_tokens, COALESCE(a.prompt_tokens, 0) + COALESCE(a.completion_tokens, 0))), 0)::text AS total_tokens,
   COALESCE(SUM(a.cached_prompt_tokens) FILTER (WHERE a.cached_prompt_tokens IS NOT NULL AND a.prompt_tokens IS NOT NULL), 0)::text AS cached_prompt_tokens,
   COALESCE(SUM(a.prompt_tokens) FILTER (WHERE a.cached_prompt_tokens IS NOT NULL AND a.prompt_tokens IS NOT NULL), 0)::text AS cache_eligible_prompt_tokens,
   COALESCE(SUM(a.prompt_tokens), 0)::text AS all_prompt_tokens
 FROM ai_providers p
 CROSS JOIN periods
 LEFT JOIN ai_provider_attempts a
   ON a.provider_id = p.id AND a.created_at >= periods.starts_at AND a.created_at <= $1::timestamptz
 WHERE p.deleted_at IS NULL
 GROUP BY p.id, p.name, p.sort_order, periods.period
 ORDER BY p.sort_order, p.id, CASE periods.period WHEN 'today' THEN 1 WHEN 'week' THEN 2 ELSE 3 END`;

const legacyRuntimeSql = `SELECT
   COUNT(*) FILTER (WHERE status = 'created') AS created,
   COUNT(*) FILTER (WHERE status = 'running') AS running,
   COUNT(*) FILTER (WHERE status = 'retrying') AS retrying,
   COUNT(*) FILTER (WHERE status = 'failed') AS failed,
   COUNT(*) FILTER (WHERE status = 'dead-lettered') AS dead_lettered,
   COUNT(*) FILTER (WHERE status = 'closed') AS closed,
   COUNT(*) FILTER (WHERE status = 'retrying' AND next_retry_at <= $1) AS stale_retrying,
   MIN(created_at) FILTER (WHERE status = 'dead-lettered') AS oldest_dead_letter_at
 FROM workflow_executions`;
const legacyOutboundSql = `SELECT
   COUNT(*) FILTER (WHERE d.status = 'sending') AS sending,
   COUNT(*) FILTER (WHERE d.status = 'unknown' AND d.closed_at IS NULL AND d.kind IN ('text','generated_image') AND (e.status IS DISTINCT FROM 'closed' OR e.startup_closure IS NOT NULL)) AS unknown
 FROM outbound_deliveries d LEFT JOIN workflow_executions e ON e.id = d.execution_id`;

const eligible = `c.enabled AND c.deleted_at IS NULL AND ($3::boolean OR NOT m.is_from_me)
 AND m.content_redacted_at IS NULL
 AND (m.revision_state IN ('retracted','partial','unresolved') OR (m.body IS NOT NULL AND m.body<>'') OR m.link_preview_status='available' OR m.attachments<>'[]'::jsonb)`;

describe.runIf(!!url)("query rewrites return the former results", () => {
  let db: Pool,
    archive: PostgresArchiveRepository,
    context: ConversationContextService,
    workflow: PostgresWorkflowRepository,
    ai: PostgresAiRepository;
  beforeAll(() => {
    db = new Pool({ connectionString: url });
    archive = new PostgresArchiveRepository(url!);
    context = new ConversationContextService(url!);
    workflow = new PostgresWorkflowRepository(url!);
    ai = new PostgresAiRepository(url!);
  });
  afterAll(async () => {
    await Promise.all([
      db.end(),
      archive.close(),
      context.close(),
      workflow.close(),
      ai.close(),
    ]);
  });

  /** Run old and new on one snapshot so concurrent test files cannot interfere. */
  async function sameSnapshot<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await db.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return await work(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  async function chat(texts: readonly (string | null)[], start = 0) {
    const chatGuid = `iMessage;-;fictional-perf-${randomUUID()}`;
    const adapter = new BlueBubblesWebhookAdapter();
    const ids: string[] = [];
    for (const [i, text] of texts.entries()) {
      const normalized = adapter.normalize(
        newMessageWebhook({
          chatGuid,
          messageGuid: `${chatGuid}-${i + 1}`,
          text,
          // Arrival order differs from sent order to exercise sent-time rules.
          dateCreated:
            Date.parse("2026-01-01T00:00:00Z") +
            (start + ((i * 7) % texts.length)) * 1000,
        }),
        randomUUID(),
      );
      if (normalized.kind !== "message") throw new Error("fixture");
      ids.push(
        (await archive.ingestMessage(normalized.envelope, true)).messageId!,
      );
    }
    const chatId = (
      await db.query<{ chat_id: string }>(
        "SELECT chat_id FROM messages WHERE id=$1",
        [ids[0]],
      )
    ).rows[0]!.chat_id;
    return { chatGuid, chatId, ids };
  }

  async function executionFixture() {
    const w = randomUUID(),
      v = randomUUID(),
      t = randomUUID();
    await db.query(
      "INSERT INTO workflows(id,name,status) VALUES($1,'fictional','draft')",
      [w],
    );
    await db.query(
      "INSERT INTO workflow_versions(id,workflow_id,version,status,definition) VALUES($1,$2,1,'draft','{}')",
      [v, w],
    );
    await db.query(
      "INSERT INTO bot_triggers(id,name,workflow_version_id,conditions) VALUES($1,'fictional',$2,'{}')",
      [t, v],
    );
    return async (input: {
      source?: string | null;
      boundary?: unknown;
      targetChatId?: string | null;
      triggerEvent?: unknown;
      status?: string;
    }) => {
      const id = randomUUID();
      await db.query(
        `INSERT INTO workflow_executions(id,provider,external_event_id,source_message_id,trigger_id,workflow_version_id,correlation_id,status,history_boundary,target_chat_id,trigger_event)
         VALUES($1::uuid,'bluebubbles',$1::text,$2,$3,$4,$1::uuid,$5,COALESCE($6::jsonb,'{"contract":"sent-time-v1"}'::jsonb),$7,$8::jsonb)`,
        [
          id,
          input.source ?? null,
          t,
          v,
          input.status ?? "created",
          input.boundary === undefined ? null : JSON.stringify(input.boundary),
          input.targetChatId ?? null,
          input.triggerEvent === undefined
            ? null
            : JSON.stringify(input.triggerEvent),
        ],
      );
      if (input.boundary === null)
        await db.query(
          "UPDATE workflow_executions SET history_boundary=NULL WHERE id=$1",
          [id],
        );
      return id;
    };
  }

  it("inlines execution_history_allows() with identical membership for every boundary shape", async () => {
    const a = await chat(
      Array.from({ length: 9 }, (_, i) => `Fictional a${i}`),
    );
    const b = await chat(
      Array.from({ length: 4 }, (_, i) => `Fictional b${i}`),
    );
    const execution = await executionFixture();
    const trigger = a.ids[5]!;
    const frozen = await execution({ source: trigger });
    await db.query("SELECT freeze_execution_history($1)", [frozen]);
    // Late arrivals after the freeze, sent before and at the trigger time.
    const late = await db.query<{ sent_at: Date }>(
      "SELECT sent_at FROM messages WHERE id=$1",
      [trigger],
    );
    const adapter = new BlueBubblesWebhookAdapter();
    for (const offset of [-3_000, 0]) {
      const normalized = adapter.normalize(
        newMessageWebhook({
          chatGuid: a.chatGuid,
          messageGuid: `${a.chatGuid}-late-${offset}`,
          text: "Fictional late",
          dateCreated: late.rows[0]!.sent_at.getTime() + offset,
        }),
        randomUUID(),
      );
      if (normalized.kind !== "message") throw new Error("fixture");
      await archive.ingestMessage(normalized.envelope, true);
    }
    const sentAtText = (
      await db.query<{ boundary: { beforeSentAt: string } }>(
        "SELECT history_boundary AS boundary FROM workflow_executions WHERE id=$1",
        [frozen],
      )
    ).rows[0]!.boundary.beforeSentAt;
    const cases: [string | null, string][] = [
      [null, "unrestricted"],
      [randomUUID(), "denied"],
      [frozen, "sent-time"],
      [await execution({ source: trigger }), "arrival"],
      [await execution({ source: trigger, boundary: null }), "arrival"],
      [await execution({ source: b.ids[2]! }), "arrival"],
      [
        await execution({ source: trigger, boundary: { upperIndex: null } }),
        "function",
      ],
      [
        await execution({ source: trigger, boundary: ["upperIndex"] }),
        "function",
      ],
      [
        await execution({
          source: trigger,
          boundary: {
            upperIndex: "8",
            triggerIndex: "4",
            beforeSentAt: sentAtText.replace("T", " ").replace("Z", "+00"),
          },
        }),
        "function",
      ],
      [
        await execution({
          targetChatId: a.chatId,
          triggerEvent: {
            schemaVersion: "chat-idle-v1",
            idle: { upperMessageIndex: "4" },
          },
        }),
        "window",
      ],
      [
        await execution({
          targetChatId: a.chatId,
          triggerEvent: {
            schemaVersion: "scheduled-task-v2",
            scheduled: { upperMessageIndex: "7" },
          },
        }),
        "window",
      ],
      [
        await execution({
          targetChatId: a.chatId,
          triggerEvent: { schemaVersion: "chat-idle-v1", idle: {} },
        }),
        "denied",
      ],
      [
        await execution({
          targetChatId: a.chatId,
          triggerEvent: {
            schemaVersion: "fictional-v9",
            idle: { upperMessageIndex: "4" },
          },
        }),
        "denied",
      ],
    ];
    for (const [executionId, kind] of cases) {
      const boundary = await readExecutionHistoryBoundary(db, executionId);
      expect(boundary.kind).toBe(kind);
      const inline = withExecutionHistory([[a.chatId, b.chatId]], boundary);
      const [expected, actual] = await Promise.all([
        db.query<{ id: string }>(
          "SELECT m.id FROM messages m WHERE m.chat_id=ANY($1::uuid[]) AND execution_history_allows($2::uuid,m.id) ORDER BY m.id",
          [[a.chatId, b.chatId], executionId],
        ),
        db.query<{ id: string }>(
          `SELECT m.id FROM messages m WHERE m.chat_id=ANY($1::uuid[]) AND ${inline.sql} ORDER BY m.id`,
          inline.values,
        ),
      ]);
      expect(actual.rows, `${kind} ${executionId}`).toEqual(expected.rows);
    }
    // The frozen boundary really is narrower than the whole chat.
    const frozenBoundary = await readExecutionHistoryBoundary(db, frozen);
    const allowed = withExecutionHistory([a.chatId], frozenBoundary);
    const n = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages m WHERE m.chat_id=$1 AND ${allowed.sql}`,
      allowed.values,
    );
    expect(n.rows[0]!.n).toBeGreaterThan(0);
    expect(n.rows[0]!.n).toBeLessThan(a.ids.length);
  });

  it("chooses the same fresh raw-context-v1 boundary without counting from index 0", async () => {
    const f = await chat(
      Array.from({ length: 14 }, (_, i) => (i === 4 ? "" : `Fictional ${i}`)),
    );
    await db.query(
      "UPDATE messages SET is_from_me=true WHERE id=ANY($1::uuid[])",
      [[f.ids[2], f.ids[9]]],
    );
    await db.query(
      "UPDATE messages SET content_redacted_at=now(),body=NULL WHERE id=$1",
      [f.ids[7]],
    );
    for (const includeFromMe of [true, false])
      for (const base of [0, 1, 3, 6, 9, 30]) {
        for (const triggerNumber of [1, 8, 14]) {
          await db.query(
            "DELETE FROM conversation_context_windows WHERE chat_id=$1",
            [f.chatId],
          );
          const trigger = (
            await db.query<{ message_index: string }>(
              "SELECT message_index::text FROM messages WHERE id=$1",
              [f.ids[triggerNumber - 1]],
            )
          ).rows[0]!.message_index;
          const values = [f.chatId, trigger, includeFromMe, "0"];
          const count = Number(
            (
              await db.query<{ count: string }>(
                `SELECT count(*)::text FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.chat_id=$1 AND m.message_index<$2 AND m.message_index>$4 AND ${eligible}`,
                values,
              )
            ).rows[0]!.count,
          );
          const expected =
            (
              await db.query<{ message_index: string }>(
                `SELECT m.message_index::text FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.chat_id=$1 AND m.message_index<$2 AND m.message_index>$4 AND ${eligible} ORDER BY m.message_index DESC OFFSET $5 LIMIT 1`,
                [...values, Math.min(count, base)],
              )
            ).rows[0]?.message_index ?? "0";
          const snapshot = (
            await context.snapshotForMessage({
              provider: "bluebubbles",
              providerChatId: f.chatGuid,
              providerMessageId: `${f.chatGuid}-${triggerNumber}`,
              settings: {
                includeFromMe,
                baseMessageWindow: base,
                redundancyMessageWindow: 2,
                characterLimit: 6000,
              },
              settingsVersion: 1,
              compatibilityInitialized: true,
            })
          ).contextSnapshot;
          expect(
            snapshot.afterMessageIndex,
            `${includeFromMe} ${base} ${triggerNumber}`,
          ).toBe(expected);
        }
      }
  });

  it("matches the former keyword search, treating LIKE wildcards literally", async () => {
    const f = await chat([
      "Fictional 100% Sure",
      "fictional 100 sure",
      "path C:\\Fictional\\dir",
      "snake_case fictional",
      "snakeXcase fictional",
      "ÄRGER Fictional",
      null,
    ]);
    await db.query(
      "UPDATE messages SET content_redacted_at=now(),body=NULL WHERE id=$1",
      [f.ids[1]],
    );
    for (const keyword of [
      "100%",
      "%",
      "_",
      "snake_case",
      "\\fictional\\",
      "\\",
      "ärger",
      "FICTIONAL",
      "missing",
    ]) {
      const expected = await db.query<{ id: string }>(
        `SELECT m.id FROM messages m WHERE m.chat_id=$1 AND POSITION(LOWER($2) IN LOWER(COALESCE(m.body, ''))) > 0 ORDER BY m.sent_at DESC, m.id DESC`,
        [f.chatId, keyword],
      );
      const actual = await archive.searchMessages({
        chatId: f.chatId,
        keyword,
        senderId: null,
        sentFrom: null,
        sentTo: null,
        limit: 50,
        cursor: null,
      });
      expect(
        actual.map((m) => m.id),
        keyword,
      ).toEqual(expected.rows.map((r) => r.id));
    }
    const all = await archive.searchMessages({
      chatId: f.chatId,
      keyword: "",
      senderId: null,
      sentFrom: null,
      sentTo: null,
      limit: 50,
      cursor: null,
    });
    expect(all).toHaveLength(f.ids.length);
  });

  it("returns the former runtime summary", async () => {
    const execution = await executionFixture();
    for (const status of ["closed", "dead-lettered", "retrying", "failed"])
      await execution({ status });
    const staleBefore = new Date(Date.now() + 60_000);
    const legacy = async () => {
      const [executions, outbound] = await sameSnapshot(
        async (client) =>
          [
            (
              await client.query<Record<string, string | null>>(
                legacyRuntimeSql,
                [staleBefore.toISOString()],
              )
            ).rows[0]!,
            (await client.query<Record<string, string>>(legacyOutboundSql))
              .rows[0]!,
          ] as const,
      );
      return {
        executions: {
          created: Number(executions.created),
          running: Number(executions.running),
          retrying: Number(executions.retrying),
          failed: Number(executions.failed),
          deadLettered: Number(executions.dead_lettered),
          closed: Number(executions.closed),
          staleRetrying: Number(executions.stale_retrying),
        },
        outbound: {
          sending: Number(outbound.sending),
          unknown: Number(outbound.unknown),
        },
        oldestDeadLetterAt:
          (
            executions.oldest_dead_letter_at as unknown as Date | null
          )?.toISOString() ?? null,
      };
    };
    // Other test files write concurrently; compare only when the legacy
    // result is unchanged before and after the new query.
    for (let attempt = 0; ; attempt++) {
      const before = await legacy();
      const summary = await workflow.getRuntimeSummary(staleBefore);
      const after = await legacy();
      if (JSON.stringify(before) !== JSON.stringify(after) && attempt < 20)
        continue;
      expect(summary).toEqual(before);
      expect(summary.executions.deadLettered).toBeGreaterThan(0);
      break;
    }
  });

  it("returns the former AI usage periods from a single pass", async () => {
    const suffix = randomUUID();
    const providers: { id: string }[] = [];
    for (const name of ["one", "two", "idle"]) {
      const created = await ai.createProvider({
        name: `Usage ${name} ${suffix}`,
        apiKind: "responses",
        baseUrl: "https://fixture.example.test/v1",
        model: "fictional",
        parameters: {},
        requestTimeoutMs: 5000,
        enabled: true,
      });
      if (created.status !== "ok") throw new Error("fixture");
      providers.push(created.value);
    }
    const route = await ai.createRoute({
      name: `Usage route ${suffix}`,
      providerIds: providers.map((p) => p.id),
      fallbackEnabled: true,
      retryPolicy: { maxRounds: 1, initialDelayMs: 0 },
      degradePolicy: { failureThreshold: 1, cooldownMs: 1_000 },
      enabled: true,
    });
    if (route.status !== "ok") throw new Error("fixture");
    // 2026-12-01 is a Tuesday: the week starts before the month.
    const times = [
      "2026-11-29T23:00:00Z",
      "2026-11-30T10:00:00Z",
      "2026-11-30T16:30:00Z",
      "2026-12-01T00:00:00Z",
      "2026-12-01T09:59:59Z",
      "2026-12-01T10:00:00Z",
      "2026-12-01T10:00:01Z",
      "2026-11-02T12:00:00Z",
    ];
    for (const [i, at] of times.entries())
      await db.query(
        `INSERT INTO ai_provider_attempts(id,route_id,route_version,provider_id,provider_name,provider_version,model,round,sequence,status,selection_health_state,health_state,duration_ms,created_at,purpose,background_operation_id,prompt_tokens,completion_tokens,total_tokens,cached_prompt_tokens,reasoning_tokens)
         VALUES($1,$2,$3,$4,'fictional',1,'fictional',1,1,$5,'healthy','healthy',1,$6,'context-summary',$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(),
          route.value.id,
          route.value.version,
          providers[i % 2]!.id,
          i % 3 === 0 ? "failed" : "succeeded",
          at,
          randomUUID(),
          i % 4 === 0 ? null : 100 + i,
          i % 5 === 0 ? null : 10 + i,
          i % 2 === 0 ? null : 120 + i,
          i % 3 === 1 ? 50 + i : null,
          i % 2 ? 3 : null,
        ],
      );
    for (const [now, timeZone] of [
      ["2026-12-01T10:00:00Z", "UTC"],
      ["2026-12-01T10:00:00Z", "Asia/Shanghai"],
      ["2026-12-01T10:00:00Z", "America/Los_Angeles"],
      ["2026-11-30T12:00:00Z", "Pacific/Kiritimati"],
    ] as const) {
      const [expected, actual] = await sameSnapshot(
        async (client) =>
          [
            await client.query<{ provider_id: string }>(legacyUsagePeriodSql, [
              new Date(now),
              timeZone,
            ]),
            await client.query<{ provider_id: string }>(aiUsagePeriodSql, [
              new Date(now),
              timeZone,
            ]),
          ] as const,
      );
      expect(actual.rows, `${now} ${timeZone}`).toEqual(expected.rows);
      const ours = actual.rows.filter((row) =>
        providers.some((p) => p.id === row.provider_id),
      );
      expect(ours).toHaveLength(9);
    }
    const report = await ai.getUsage({
      hours: 24,
      timeZone: "UTC",
      now: new Date("2026-12-01T10:00:00Z"),
    });
    const one = report.periods.find((p) => p.providerId === providers[0]!.id);
    // Provider one has times 0, 2, 4, 6. 6 is after now; 0 is the Sunday
    // before the week; the week (from Monday 11-30) is wider than the month.
    expect(one?.today.requestCount).toBe(1);
    expect(one?.week.requestCount).toBe(2);
    expect(one?.month.requestCount).toBe(1);
  });
});
