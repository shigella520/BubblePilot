/** Synthetic PostgreSQL distance/keyword benchmark; never uses production data. */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
const url = process.env.MEMORY_BENCH_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_memory_bench"))
  throw new Error("Use a dedicated database ending in _memory_bench.");
const client = new Client({ connectionString: url });
await client.connect();
const dimensions = 1024;
const value = Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0));
try {
  await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  // TEMP tables cannot overwrite application tables and disappear on disconnect.
  await client.query(
    "CREATE TEMP TABLE memory_benchmark(id integer,chat_id uuid,embedding vector(1024),keywords tsvector)",
  );
  const chatId = randomUUID();
  const report = [];
  for (const size of [10000, 100000]) {
    await client.query("TRUNCATE memory_benchmark");
    const start = performance.now();
    await client.query(
      "INSERT INTO memory_benchmark SELECT n,$1::uuid,$2::vector,to_tsvector('simple','fictional 备份 '||n) FROM generate_series(1,$3) n",
      [chatId, JSON.stringify(value), size],
    );
    await client.query("ANALYZE memory_benchmark");
    const timings = [];
    for (let round = 0; round < 21; round++) {
      const before = performance.now();
      await client.query(
        "SELECT id FROM memory_benchmark WHERE chat_id=$1 ORDER BY embedding <=> $2::vector LIMIT 20",
        [chatId, JSON.stringify(value)],
      );
      if (round) timings.push(performance.now() - before);
    }
    timings.sort((a, b) => a - b);
    const bytes = (
      await client.query<{ bytes: string }>(
        "SELECT pg_total_relation_size('memory_benchmark')::text bytes",
      )
    ).rows[0]?.bytes;
    report.push({
      messages: size,
      dimensions,
      p50Ms: Math.round(timings[9] ?? 0),
      p95Ms: Math.round(timings[18] ?? 0),
      loadMs: Math.round(performance.now() - start),
      bytes: Number(bytes),
      limitation:
        "Synthetic exact SQL distance only; excludes embedding, worker throughput, answer generation and Mac mini load.",
    });
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  await client.end();
}
