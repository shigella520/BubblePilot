/** Developer-only model calibration. Sends only the checked-in fictional fixture. */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  HttpEmbeddingClient,
  embeddingConfigSchema,
} from "../modules/memory/embedding-client.js";
import { defaultMemoryConfig } from "../modules/memory/memory-types.js";
import { keywordTokens, fuseRanks } from "../modules/memory/chunking.js";
const fixture = z
  .object({
    sources: z.array(
      z.object({
        id: z.string(),
        date: z.string(),
        sender: z.string(),
        text: z.string(),
      }),
    ),
    cases: z.array(
      z.object({
        id: z.string(),
        split: z.string(),
        query: z.string(),
        expectedSourceIds: z.array(z.string()),
        from: z.string().optional(),
        to: z.string().optional(),
        sender: z.string().optional(),
      }),
    ),
  })
  .parse(
    JSON.parse(await readFile("tests/fixtures/memory-retrieval.json", "utf8")),
  );
if (!process.env.MEMORY_EVAL_URL)
  throw new Error(
    "Set MEMORY_EVAL_URL to an authorized embedding service. Only fictional fixtures will be sent.",
  );
const config = embeddingConfigSchema.parse({
  ...defaultMemoryConfig,
  baseUrl: process.env.MEMORY_EVAL_URL,
  protocol: process.env.MEMORY_EVAL_PROTOCOL ?? "ollama",
  model: process.env.MEMORY_EVAL_MODEL ?? defaultMemoryConfig.model,
  dimensions: Number(process.env.MEMORY_EVAL_DIMENSIONS ?? 1024),
  queryPrefix:
    process.env.MEMORY_EVAL_QUERY_PREFIX ?? defaultMemoryConfig.queryPrefix,
});
const client = new HttpEmbeddingClient();
const secret = process.env.MEMORY_EVAL_SECRET ?? null;
const vectors: number[][] = [];
for (let i = 0; i < fixture.sources.length; i += 4)
  vectors.push(
    ...(await client.encode(
      config,
      secret,
      fixture.sources
        .slice(i, i + 4)
        .map((s) => `${s.date} ${s.sender}\n${s.text}`),
    )),
  );
function cosine(a: number[], b: number[]) {
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    aa += (a[i] ?? 0) ** 2;
    bb += (b[i] ?? 0) ** 2;
  }
  return dot / Math.sqrt(aa * bb);
}
const results: {
  id: string;
  split: string;
  answerable: boolean;
  top: Record<string, string[]>;
  recall: Record<string, number | null>;
}[] = [];
for (const test of fixture.cases) {
  const q = (
    await client.encode(config, secret, [config.queryPrefix + test.query])
  )[0]!;
  const tokens = keywordTokens(test.query);
  const eligible = fixture.sources
    .map((source, i) => ({ ...source, i }))
    .filter(
      (s) =>
        (!test.sender || s.sender === test.sender) &&
        (!test.from || s.date >= test.from.slice(0, 10)) &&
        (!test.to || s.date <= test.to.slice(0, 10)),
    );
  const semantic = [...eligible].sort(
    (a, b) => cosine(q, vectors[b.i]!) - cosine(q, vectors[a.i]!),
  );
  const lexical = eligible
    .map((s) => ({
      ...s,
      score: tokens.filter((t) => keywordTokens(s.text).includes(t)).length,
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const top = {
    keyword: lexical.slice(0, 5).map((s) => s.id),
    vector: semantic.slice(0, 5).map((s) => s.id),
    hybrid: fuseRanks([lexical, semantic])
      .slice(0, 5)
      .map((s) => s.id),
  };
  results.push({
    id: test.id,
    split: test.split,
    answerable: test.expectedSourceIds.length > 0,
    top,
    recall: Object.fromEntries(
      Object.entries(top).map(([mode, ids]) => [
        mode,
        test.expectedSourceIds.length
          ? test.expectedSourceIds.filter((id) => ids.includes(id)).length /
            test.expectedSourceIds.length
          : null,
      ]),
    ),
  });
}
const aggregate = Object.fromEntries(
  ["development", "holdout"].map((split) => {
    const rows = results.filter((r) => r.split === split && r.answerable);
    return [
      split,
      Object.fromEntries(
        ["keyword", "vector", "hybrid"].map((mode) => [
          mode,
          rows.reduce((n, r) => n + (r.recall[mode] ?? 0), 0) / rows.length,
        ]),
      ),
    ];
  }),
);
process.stdout.write(
  JSON.stringify(
    {
      model: config.model,
      dimensions: config.dimensions,
      aggregate,
      results,
      limitations:
        "Embedding candidate calibration only. Summary-answer baseline, hallucination, autonomous tool choice, and real service end-to-end acceptance require separate answer-model evaluation. No-answer cases have no recall score.",
    },
    null,
    2,
  ) + "\n",
);
if (Object.values(aggregate).some((row) => (row.hybrid ?? 0) < 0.85))
  process.exitCode = 1;
