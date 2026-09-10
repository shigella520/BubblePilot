import { describe, it, expect, vi } from "vitest";
import { HttpEmbeddingClient } from "../modules/memory/embedding-client.js";
import {
  chunkMessages,
  keywordTokens,
  fuseRanks,
} from "../modules/memory/chunking.js";
import { defaultMemoryConfig } from "../modules/memory/memory-types.js";

describe("memory foundations", () => {
  it("validates Ollama vectors and forbids truncation and redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          embeddings: [
            [1, 0],
            [0, 1],
          ],
        }),
      ),
    );
    const result = await new HttpEmbeddingClient(fetcher).encode(
      { ...defaultMemoryConfig, dimensions: 2 },
      null,
      ["虚构备份", "虚构计划"],
    );
    expect(result).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(
      JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string),
    ).toMatchObject({
      truncate: false,
    });
  });
  it("records an available Ollama digest", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            { name: defaultMemoryConfig.model, digest: "fictional-digest" },
          ],
        }),
      ),
    );
    expect(
      await new HttpEmbeddingClient(fetcher).identity(
        defaultMemoryConfig,
        null,
      ),
    ).toBe("digest:fictional-digest");
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
  });
  it("orders OpenAI batch indexes and preserves a /v1 base", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        }),
      ),
    );
    expect(
      await new HttpEmbeddingClient(fetcher).encode(
        {
          ...defaultMemoryConfig,
          protocol: "openai-compatible",
          baseUrl: "https://embedding.example.test/v1/",
          dimensions: 2,
        },
        "fictional",
        ["a", "b"],
      ),
    ).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://embedding.example.test/v1/embeddings",
    );
  });
  it.each([
    { embeddings: [[1]] },
    { embeddings: [[0, 0]] },
    {
      embeddings: [
        [1, 2],
        [3, 4],
      ],
    },
  ])("rejects invalid vector batches", async (payload) => {
    const client = new HttpEmbeddingClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(payload))),
    );
    await expect(
      client.encode({ ...defaultMemoryConfig, dimensions: 2 }, null, ["x"]),
    ).rejects.toMatchObject({ code: "MEMORY_EMBEDDING_INVALID_OUTPUT" });
  });
  it("does not expose a provider error body", async () => {
    const client = new HttpEmbeddingClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("private provider body", { status: 500 }),
        ),
    );
    await expect(
      client.encode(defaultMemoryConfig, null, ["x"]),
    ).rejects.toMatchObject({ code: "MEMORY_EMBEDDING_HTTP_ERROR" });
  });
  it("retains exact identifiers and Chinese words", () => {
    expect(keywordTokens("虚构订单 DEMO-2026-0312 备份方案")).toContain(
      "demo-2026-0312",
    );
    expect(keywordTokens("备份方案")).toContain("备份");
  });
  it("splits long messages without losing text or source offsets", () => {
    const text = "虚构内容".repeat(1000);
    const chunks = chunkMessages([
      {
        id: "fictional",
        index: 1,
        sentAt: "2026-01-01T00:00:00Z",
        senderId: "sender-1",
        role: "user",
        text,
        hash: "hash",
      },
    ]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 1600)).toBe(true);
    expect(
      chunks
        .map((c) => {
          const s = c.sources[0]!;
          return text.slice(s.start, s.end);
        })
        .join(""),
    ).toBe(text);
  });
  it("separates discontinuous discussions and merges ranked sources", () => {
    const base = {
      id: "a",
      index: 1,
      sentAt: "2026-01-01T00:00:00Z",
      senderId: "one",
      role: "user" as const,
      text: "虚构备份",
      hash: "hash",
    };
    expect(
      chunkMessages([
        base,
        { ...base, id: "b", index: 2, sentAt: "2026-01-01T01:00:00Z" },
      ]),
    ).toHaveLength(2);
    expect(
      fuseRanks([
        [{ id: "a" }, { id: "b" }],
        [{ id: "b" }, { id: "c" }],
      ])[0]?.id,
    ).toBe("b");
  });
});
