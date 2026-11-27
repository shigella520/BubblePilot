import { describe, expect, it, vi } from "vitest";
import {
  embeddingConfigSchema,
  HttpEmbeddingClient,
  isUpstreamFailure,
} from "../modules/memory/embedding-client.js";
import { memorySettingsSchema } from "../modules/memory/memory-types.js";
import {
  vectorIndexSql,
  vectorLayout,
} from "../modules/memory/vector-storage.js";
import { DataHousekeeping } from "../modules/maintenance/data-housekeeping.js";

const base = {
  protocol: "openai-compatible" as const,
  baseUrl: "https://embedding.example.test/v1",
  model: "fictional-embedding",
  modelVersion: "1",
};

describe("embedding precision and dimensions", () => {
  it("limits dimensions to what pgvector can index for the precision", () => {
    expect(
      embeddingConfigSchema.safeParse({ ...base, dimensions: 1024 }).data
        ?.precision,
    ).toBe("float32");
    expect(
      embeddingConfigSchema.safeParse({ ...base, dimensions: 3072 }).success,
    ).toBe(false);
    expect(
      embeddingConfigSchema.safeParse({
        ...base,
        dimensions: 3072,
        precision: "float16",
      }).success,
    ).toBe(true);
    expect(
      memorySettingsSchema.safeParse({
        ...base,
        dimensions: 4001,
        precision: "float16",
        enabled: true,
        expectedVersion: 0,
      }).success,
    ).toBe(false);
  });
  it("stores each precision in its own column with a matching index", () => {
    const f32 = vectorLayout({ dimensions: 1024, precision: "float32" });
    expect(f32).toMatchObject({
      column: "embedding",
      expression: "embedding::vector(1024)",
      indexName: "memory_embeddings_hnsw_f32_1024",
      indexable: true,
    });
    expect(vectorIndexSql(f32)).toContain("vector_cosine_ops");
    const f16 = vectorLayout({ dimensions: 3072, precision: "float16" });
    expect(f16.expression).toBe("embedding_half::halfvec(3072)");
    expect(vectorIndexSql(f16)).toContain("halfvec_cosine_ops");
    // Legacy configs without precision are float32; too wide to index.
    expect(vectorIndexSql(vectorLayout({ dimensions: 3072 }))).toBeNull();
    expect(() => vectorLayout({ dimensions: 1.5 })).toThrow();
  });
  it("requests the configured dimensions and reports a different length", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }),
        ),
      );
    const client = new HttpEmbeddingClient(fetcher);
    await expect(
      client.encode(
        { ...base, dimensions: 3, precision: "float32", queryPrefix: "" },
        null,
        ["虚构"],
      ),
    ).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_DIMENSION_MISMATCH",
      detail: { returnedDimensions: 2 },
    });
    const sent = fetcher.mock.calls[0]?.[1]?.body;
    const body = JSON.parse(typeof sent === "string" ? sent : "{}") as {
      dimensions: number;
    };
    expect(body.dimensions).toBe(3);
  });
});

describe("upstream failure classification", () => {
  it("retries service-side failures only", () => {
    const http = (status: number) =>
      isUpstreamFailure("MEMORY_EMBEDDING_HTTP_ERROR", {
        kind: "http",
        httpStatus: status,
      });
    expect(http(500)).toBe(true);
    expect(http(503)).toBe(true);
    expect(http(429)).toBe(true);
    expect(http(400)).toBe(false);
    expect(http(401)).toBe(false);
    expect(isUpstreamFailure("MEMORY_EMBEDDING_TIMEOUT")).toBe(true);
    expect(isUpstreamFailure("MEMORY_EMBEDDING_UNAVAILABLE")).toBe(true);
    expect(isUpstreamFailure("MEMORY_EMBEDDING_DIMENSION_MISMATCH")).toBe(
      false,
    );
    expect(isUpstreamFailure("MEMORY_SOURCE_CHANGED")).toBe(false);
  });
});

describe("housekeeping tasks", () => {
  it("runs application tasks after the SQL steps and isolates their failures", async () => {
    const query = vi.fn(() => Promise.resolve({ rowCount: 0 }));
    const results = await new DataHousekeeping(
      { query } as never,
      undefined,
      undefined,
      [
        { step: "ok", run: () => Promise.resolve(3) },
        { step: "broken", run: () => Promise.reject(new Error("x")) },
      ],
    ).runOnce();
    expect(results.slice(-2)).toEqual([
      { step: "ok", rows: 3 },
      { step: "broken", rows: -1 },
    ]);
  });
});
