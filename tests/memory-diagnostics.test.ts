import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryService,
  MemorySession,
} from "../modules/memory/memory-service.js";
import type { MemoryRepository } from "../modules/memory/memory-repository.js";
import {
  EmbeddingError,
  type EmbeddingClient,
} from "../modules/memory/embedding-client.js";
import {
  defaultMemoryConfig,
  type MemoryScope,
} from "../modules/memory/memory-types.js";
import type { MemoryToolDiagnostic } from "../modules/memory/memory-diagnostics.js";
import { memoryToolLabel } from "../apps/web/src/utils/memory-tool-diagnostics.js";

function fixture() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  const repository = {
    allowed: vi.fn().mockResolvedValue(true),
    coverage: vi.fn().mockResolvedValue({ total: 0, indexed: 0, pending: 0 }),
    candidates: vi.fn().mockResolvedValue([]),
    pool: { connect: vi.fn().mockResolvedValue(client) },
  };
  const encode = vi.fn().mockResolvedValue([[1, 0]]);
  const embedding: EmbeddingClient = {
    identity: vi.fn().mockResolvedValue("fixture-model"),
    encode,
  };
  const service = new MemoryService(
    repository as unknown as MemoryRepository,
    embedding,
  );
  const scope: MemoryScope = {
    chatId: "fictional-chat",
    upperIndex: 100,
    executionId: null,
    generation: {
      id: "fictional-generation",
      config: { ...defaultMemoryConfig, dimensions: 2 },
      encrypted_secret: null,
      identity: "fixture-model",
      status: "active",
    },
  };
  const session = new MemorySession(service, scope);
  const diagnostics: MemoryToolDiagnostic[] = [];
  const execute = (argumentsJson: string) =>
    session.execute(
      "search_chat_history",
      argumentsJson,
      {
        signal: new AbortController().signal,
        deadline: Date.now() + 10000,
        maxOutputCharacters: 24000,
      },
      (diagnostic) => diagnostics.push(diagnostic),
    );
  return { repository, encode, diagnostics, execute };
}

describe("history search diagnostics", () => {
  it("records safe validation details without saving query text or unknown keys", async () => {
    const { execute, diagnostics } = fixture();
    const result = JSON.parse(
      await execute(
        JSON.stringify({
          query: "fictional-private-query",
          limit: 999,
          "fictional-private-field": "fictional-private-value",
        }),
      ),
    ) as unknown;
    expect(result).toEqual({
      status: "unavailable",
      reason: "invalid-or-unavailable",
    });
    expect(diagnostics[0]).toMatchObject({
      kind: "memory",
      status: "unavailable",
      failure: {
        stage: "validation",
        category: "invalid-arguments",
      },
    });
    expect(diagnostics[0]?.failure?.validationIssues).toContainEqual({
      field: "limit",
      code: "too_big",
    });
    expect(diagnostics[0]?.failure?.validationIssues).toContainEqual({
      code: "unrecognized_keys",
    });
    expect(JSON.stringify(diagnostics)).not.toContain("fictional-private");
    expect(
      memoryToolLabel("search_chat_history", { ...diagnostics[0] }),
    ).toContain("结果数量超出上限");
  });

  it("distinguishes invalid JSON and a database failure without copying errors", async () => {
    const invalid = fixture();
    await invalid.execute('{"query":"fictional-private');
    expect(invalid.diagnostics[0]?.failure).toEqual({
      stage: "arguments",
      category: "invalid-json",
    });
    const database = fixture();
    const error = new pg.DatabaseError("fictional-private-error", 0, "error");
    error.code = "57014";
    database.repository.coverage.mockRejectedValueOnce(error);
    await database.execute('{"query":"fictional-private-query"}');
    expect(database.diagnostics[0]?.failure).toEqual({
      stage: "coverage",
      category: "database-error",
      errorCode: "57014",
    });
    expect(JSON.stringify(database.diagnostics)).not.toContain(
      "fictional-private",
    );
  });

  it("records an embedding failure when search falls back to keywords", async () => {
    const { execute, encode, diagnostics } = fixture();
    encode.mockRejectedValueOnce(
      new EmbeddingError("MEMORY_EMBEDDING_HTTP_ERROR", 429),
    );
    const result = JSON.parse(
      await execute('{"query":"fictional-topic"}'),
    ) as unknown;
    expect(result).toMatchObject({
      status: "no-results",
      retrievalMode: "keyword-only",
    });
    expect(diagnostics[0]).toMatchObject({
      status: "no-results",
      mode: "keyword-only",
      embeddingFallback: {
        stage: "embedding-query",
        category: "embedding-error",
        errorCode: "MEMORY_EMBEDDING_HTTP_ERROR",
        httpStatus: 429,
      },
    });
    expect(
      memoryToolLabel("search_chat_history", { ...diagnostics[0] }),
    ).toContain("向量检索已降级");
    expect(
      memoryToolLabel("search_chat_history", { ...diagnostics[0] }),
    ).toContain("HTTP 429");
    expect(JSON.stringify(diagnostics)).not.toContain("fictional-topic");
  });

  it("records mixed retrieval and explains when the keyword branch failed", async () => {
    const { execute, repository, diagnostics } = fixture();
    repository.candidates.mockRejectedValueOnce(
      new Error("fictional-private-error"),
    );
    const result = JSON.parse(await execute('{"query":"fictional-topic"}')) as {
      retrievalMode: string;
    };
    expect(result.retrievalMode).toBe("hybrid");
    expect(diagnostics[0]).toMatchObject({
      mode: "hybrid",
      keywordFailure: { stage: "keyword-search", category: "internal-error" },
    });
    expect(
      memoryToolLabel("search_chat_history", { ...diagnostics[0] }),
    ).toContain("关键词检索失败");
  });
});
