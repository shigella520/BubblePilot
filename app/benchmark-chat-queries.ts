/** Fictional TEMP archive only. Connection close drops all benchmark data. */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { ChatQueryRepository } from "../modules/memory/chat-query-repository.js";
import {
  chatMessageQuerySchema,
  chatCountQuerySchema,
  chatExtremaQuerySchema,
} from "../modules/memory/chat-query-types.js";
import {
  defaultMemoryConfig,
  type MemoryScope,
} from "../modules/memory/memory-types.js";
const url = process.env.CHAT_QUERY_BENCH_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Use an isolated fixture database ending in _test.");
const pool = new Pool({
  connectionString: url,
  max: 1,
  statement_timeout: 5000,
});
const chatId = randomUUID();
const scope: MemoryScope = {
  chatId,
  upperIndex: 100001,
  executionId: null,
  generation: {
    id: randomUUID(),
    config: defaultMemoryConfig,
    identity: "fixture",
    encrypted_secret: null,
    status: "active",
  },
};
try {
  await pool.query(
    "CREATE TEMP TABLE messages(id uuid,chat_id uuid,message_index bigint,sent_at timestamptz,sender_id text,body text,content_redacted_at timestamptz,is_from_me boolean,attachments jsonb,link_previews jsonb)",
  );
  await pool.query(
    "CREATE TEMP TABLE message_image_summaries(id uuid,message_id uuid,status text,summary text)",
  );
  await pool.query(
    "CREATE INDEX ON messages(chat_id,sent_at,message_index) WHERE content_redacted_at IS NULL",
  );
  await pool.query(
    "CREATE INDEX ON messages(chat_id,sender_id,sent_at,message_index) WHERE content_redacted_at IS NULL",
  );
  const repo = new ChatQueryRepository(pool);
  const report = [];
  for (const size of [10000, 100000]) {
    await pool.query("TRUNCATE messages");
    await pool.query(
      "INSERT INTO messages SELECT md5(n::text)::uuid,$1,n,'2026-01-01'::timestamptz+n*interval '1 minute','fictional-'||(n%10),'fictional backup '||(n%5),NULL,FALSE,'[]','[]' FROM generate_series(1,$2) n",
      [chatId, size],
    );
    await pool.query("ANALYZE messages");
    const operations = {
      latest: () =>
        repo.query(
          scope,
          chatMessageQuerySchema.parse({ senderId: "fictional-1" }),
          "Asia/Shanghai",
        ),
      count: () =>
        repo.aggregate(
          scope,
          chatCountQuerySchema.parse({
            keywords: ["backup"],
            keywordMode: "all",
          }),
          "Asia/Shanghai",
        ),
      dailyExtrema: () =>
        repo.aggregate(
          scope,
          chatExtremaQuerySchema.parse({
            groupBy: "day",
            pick: "first",
            from: "2026-01-01T00:00:00Z",
            to: "2026-03-31T23:59:59Z",
          }),
          "Asia/Shanghai",
        ),
    };
    for (const [name, run] of Object.entries(operations)) {
      const timings = [];
      for (let i = 0; i < 11; i++) {
        const started = performance.now();
        await run();
        if (i) timings.push(performance.now() - started);
      }
      timings.sort((a, b) => a - b);
      report.push({
        size,
        name,
        p50Ms: Math.round(timings[4]!),
        p95Ms: Math.round(timings[9]!),
      });
    }
  }
  const plan = await pool.query(
    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM messages WHERE chat_id=$1 AND sender_id=$2 AND content_redacted_at IS NULL AND message_index<100001 ORDER BY sent_at DESC,message_index DESC LIMIT 20",
    [chatId, "fictional-1"],
  );
  process.stdout.write(
    JSON.stringify(
      {
        report,
        latestPlan: plan.rows,
        limitation:
          "Warm local PostgreSQL synthetic TEMP archive; no model, network, ingestion or NAS load.",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await pool.end();
}
