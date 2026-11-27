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
import {
  embeddingFailureSummary,
  memoryToolLabel,
} from "../apps/web/src/utils/memory-tool-diagnostics.js";
import { memoryTools } from "../modules/memory/memory-service.js";
import { restoreToolArguments } from "../modules/ai/tool-schema.js";

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
  return { repository, encode, diagnostics, execute, session };
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
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "invalid-arguments",
      issues: [
        { field: "limit", code: "too_big", maximum: 20 },
        { code: "unrecognized_keys" },
      ],
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
    expect(JSON.stringify(result)).not.toContain("fictional-private");
    expect(
      memoryToolLabel("search_chat_history", { ...diagnostics[0] }),
    ).toContain("结果数量超出上限");
  });

  it("reports empty filters and accepts null placeholders without broadening a requested identity", async () => {
    const { execute, repository } = fixture();
    const bad = JSON.parse(
      await execute(
        JSON.stringify({
          query: "fictional-topic",
          botWorkflowId: "",
          senderId: "",
          from: "",
          to: "",
        }),
      ),
    ) as { issues: { field?: string; code: string }[]; guidance: string };
    expect(bad.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "botWorkflowId",
          code: "invalid_format",
        }),
        expect.objectContaining({ field: "senderId", code: "too_small" }),
        expect.objectContaining({ field: "from", code: "invalid_format" }),
        expect.objectContaining({ field: "to", code: "invalid_format" }),
      ]),
    );
    expect(bad.guidance).toContain("Do not guess identities");
    expect(repository.candidates).not.toHaveBeenCalled();
    const definition = memoryTools.find(
      (tool) => tool.name === "search_chat_history",
    )!;
    const corrected = restoreToolArguments(
      definition.parameters,
      JSON.stringify({
        query: "fictional-topic",
        botWorkflowId: null,
        senderId: null,
        from: null,
        to: null,
        limit: null,
      }),
    );
    expect(JSON.parse(await execute(corrected))).toMatchObject({
      status: "no-results",
    });
    expect(repository.candidates).toHaveBeenCalledWith(
      expect.anything(),
      { query: "fictional-topic" },
      null,
    );
  });

  it("explains conditional rules for chat statistics without leaking input", async () => {
    const { session } = fixture();
    const result = JSON.parse(
      await session.execute(
        "count_chat_messages",
        JSON.stringify({ groupBy: "day" }),
      ),
    ) as { reason: string; issues: { guidance?: string }[] };
    expect(result.reason).toBe("invalid-arguments");
    expect(result.issues).toContainEqual({
      code: "custom",
      guidance: "Time grouping requires both from and to.",
    });
  });

  it.each([
    [
      "query_chat_messages",
      {
        senderId: "fictional-private",
        botWorkflowId: "00000000-0000-4000-8000-000000000001",
      },
      "Use either senderId or botWorkflowId, not both.",
    ],
    [
      "query_chat_messages",
      { keywords: ["fictional-private"] },
      "Provide keywords and keywordMode together.",
    ],
    [
      "query_chat_messages",
      { hasAttachments: false, attachmentName: "fictional-private" },
      "Do not combine hasAttachments=false with attachmentName or attachmentType.",
    ],
    [
      "query_chat_messages",
      { from: "2030-01-02T00:00:00Z", to: "2030-01-01T00:00:00Z" },
      "from must be no later than to.",
    ],
    [
      "query_chat_messages",
      { dailyTime: { from: "09:00", to: "09:00" } },
      "dailyTime from and to must differ.",
    ],
    [
      "count_chat_messages",
      { groupBy: "none", cursor: "00000000-0000-4000-8000-000000000001" },
      "An ungrouped query cannot use a cursor.",
    ],
    [
      "count_chat_messages",
      { groupBy: "sender", breakdownBy: "sender" },
      "breakdownBy requires a time grouping; hourOfDay breakdown requires weekday grouping.",
    ],
    [
      "get_chat_message_extrema",
      { pick: "first", groupBy: "day" },
      "Time grouping requires both from and to.",
    ],
    [
      "search_chat_history",
      {
        query: "fictional-private",
        senderId: "fictional-private",
        botWorkflowId: "00000000-0000-4000-8000-000000000001",
      },
      "Use either senderId or botWorkflowId, not both.",
    ],
  ])(
    "returns a safe correction for %s conditional parameters",
    async (name, args, rule) => {
      const { session } = fixture();
      const result = await session.execute(name, JSON.stringify(args));
      const payload = JSON.parse(result) as {
        reason: string;
        issues: { code: string; guidance?: string }[];
      };
      expect(payload.reason).toBe("invalid-arguments");
      expect(
        payload.issues.some(
          (issue) => issue.code === "custom" && issue.guidance === rule,
        ),
      ).toBe(true);
      expect(result).not.toContain("fictional-private");
    },
  );

  it("distinguishes invalid JSON and a database failure without copying errors", async () => {
    const invalid = fixture();
    const badJson = await invalid.execute('{"query":"fictional-private');
    expect(JSON.parse(badJson)).toMatchObject({
      reason: "invalid-arguments",
      issues: [{ code: "invalid_json" }],
    });
    expect(invalid.diagnostics[0]?.failure).toEqual({
      stage: "arguments",
      category: "invalid-json",
    });
    const database = fixture();
    const error = new pg.DatabaseError("fictional-private-error", 0, "error");
    error.code = "57014";
    database.repository.coverage.mockRejectedValueOnce(error);
    const failed = await database.execute(
      '{"query":"fictional-private-query"}',
    );
    expect(JSON.parse(failed)).toMatchObject({
      status: "unavailable",
      reason: "query-failed",
      failure: {
        stage: "coverage",
        category: "database-error",
        errorCode: "57014",
      },
    });
    expect(failed).not.toContain("fictional-private");
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
      warnings: [
        {
          component: "semantic",
          code: "MEMORY_EMBEDDING_HTTP_ERROR",
          httpStatus: 429,
        },
      ],
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

  it("keeps sanitized upstream facts for timeouts and gateway errors", async () => {
    const { execute, encode, diagnostics } = fixture();
    encode.mockRejectedValueOnce(
      new EmbeddingError("MEMORY_EMBEDDING_HTTP_ERROR", 500, {
        kind: "http",
        httpStatus: 500,
        upstreamRequestId: "fictional0gateway0id",
        upstreamCode: "api_error",
        elapsedMs: 4200,
      }),
    );
    await execute('{"query":"fictional-topic"}');
    expect(diagnostics[0]?.embeddingFallback).toMatchObject({
      failureKind: "http",
      httpStatus: 500,
      upstreamRequestId: "fictional0gateway0id",
      upstreamCode: "api_error",
      elapsedMs: 4200,
    });
    const label = memoryToolLabel("search_chat_history", {
      ...diagnostics[0],
    });
    expect(label).toContain("HTTP 500");
    expect(label).toContain("上游请求 ID fictional0gateway0id");
    expect(
      embeddingFailureSummary({
        kind: "timeout",
        timeoutMs: 15000,
        elapsedMs: 15003,
      }),
    ).toBe("超时（上限 15 秒）");
    expect(
      embeddingFailureSummary({
        kind: "http",
        httpStatus: 500,
        upstreamRequestId: "bad id with spaces",
        upstreamCode: "<script>",
        elapsedMs: 3937,
      }),
    ).toBe("HTTP 500 · 耗时 3.9 秒");
    expect(embeddingFailureSummary(null)).toBe("");
  });

  it("records mixed retrieval and explains when the keyword branch failed", async () => {
    const { execute, repository, diagnostics } = fixture();
    repository.candidates.mockRejectedValueOnce(
      new Error("fictional-private-error"),
    );
    const result = JSON.parse(await execute('{"query":"fictional-topic"}')) as {
      retrievalMode: string;
      warnings: unknown[];
    };
    expect(result.retrievalMode).toBe("hybrid");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        component: "keyword",
        code: "KEYWORD_SEARCH_FAILED",
      }),
    );
    expect(diagnostics[0]).toMatchObject({
      mode: "hybrid",
      keywordFailure: { stage: "keyword-search", category: "internal-error" },
    });
    expect(
      memoryToolLabel("search_chat_history", { ...diagnostics[0] }),
    ).toContain("关键词检索失败");
  });

  it("tells the model when both retrieval branches fail", async () => {
    const { execute, repository, encode } = fixture();
    repository.candidates.mockRejectedValueOnce(new Error("fictional-secret"));
    encode.mockRejectedValueOnce(
      new EmbeddingError("MEMORY_EMBEDDING_UNAVAILABLE"),
    );
    const text = await execute('{"query":"fictional-private-query"}');
    expect(JSON.parse(text)).toMatchObject({
      status: "unavailable",
      reason: "retrieval-unavailable",
      warnings: [
        { component: "semantic", code: "MEMORY_EMBEDDING_UNAVAILABLE" },
        { component: "keyword", code: "KEYWORD_SEARCH_FAILED" },
      ],
    });
    expect(text).not.toContain("fictional-secret");
    expect(text).not.toContain("fictional-private-query");
  });
});
