import { describe, expect, it, vi } from "vitest";

import {
  executeSummaryWithRecovery,
  contextRetentionThreshold,
  contextCompressionBatchRange,
  conversationContextCacheKey,
  conversationContextProfileHash,
  contextCompressionPlan,
  contextFastForwardPlan,
  ConversationContextService,
  ConversationSummaryWorker,
  conversationCompressionPrompt,
  conversationCompressionTranscript,
  fitContextMessages,
  historyCoverage,
} from "../modules/workflow/conversation-context-service.js";
import { conversationHistoryMessages } from "../modules/workflow/node-registry.js";
import type { ContextMessage } from "../modules/archive/archive-repository.js";
import type { PreparedImageInputItem } from "../modules/ai/native-image-input.js";
import { emptyLinkPreview } from "../modules/ingestion/link-preview.js";
import { parseWorkflowDefinition } from "../modules/workflow/workflow-definition.js";

function definition(config: Record<string, unknown>) {
  return {
    schemaVersion: "1",
    name: "context summary",
    startNodeId: "load-history",
    maxSteps: 4,
    nodes: [
      {
        id: "load-history",
        type: "load-context",
        version: 1,
        config,
        onSuccess: "end",
      },
      {
        id: "end",
        type: "end",
        version: 1,
        config: { result: "succeeded" },
      },
    ],
  };
}

function contextMessage(
  id: string,
  overrides: Partial<ContextMessage> = {},
): ContextMessage {
  return {
    providerMessageId: id,
    senderId: "user@example.test",
    sentAt: `2026-08-10T00:00:${id.padStart(2, "0")}.000Z`,
    body: `message-${id}`,
    isFromMe: false,
    attachments: [],
    linkPreview: emptyLinkPreview(),
    ...overrides,
  };
}

function sharedMessagePrefixLength(
  left: ReturnType<typeof conversationHistoryMessages>,
  right: ReturnType<typeof conversationHistoryMessages>,
): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (
    index < limit &&
    JSON.stringify(left[index]) === JSON.stringify(right[index])
  ) {
    index += 1;
  }
  return index;
}

describe("conversation context summary contract", () => {
  it("runs one startup catch-up scan before processing queued work", async () => {
    const enqueueStartupCatchups = vi.fn().mockResolvedValue(2);
    const processQueued = vi.fn().mockResolvedValue(false);
    const worker = new ConversationSummaryWorker(
      {
        enqueueStartupCatchups,
        processQueued,
      } as unknown as ConversationContextService,
      () => Promise.resolve("11111111-1111-4111-8111-111111111111"),
      () => Promise.resolve("UTC"),
      5_000,
      () =>
        Promise.resolve({
          enabled: true,
          providerRouteId: "11111111-1111-4111-8111-111111111111",
          baseMessageWindow: 4,
          redundancyMessageWindow: 3,
          includeFromMe: true,
          timeZone: "UTC",
          policyVersion: 2,
        }),
    );

    worker.trigger();
    await worker.stop();
    worker.trigger();
    await worker.stop();

    expect(enqueueStartupCatchups).toHaveBeenCalledOnce();
    expect(processQueued).toHaveBeenCalledTimes(2);
  });

  it("keeps load-context configuration global", () => {
    const parsed = parseWorkflowDefinition(definition({}));
    const node = parsed.nodes[0];
    expect(node?.type).toBe("load-context");
    if (node?.type !== "load-context") return;
    expect(node.config).toEqual({});
  });

  it("does not accept node-level summary settings as runtime inputs", () => {
    const parsed = parseWorkflowDefinition(definition({}));
    const node = parsed.nodes[0];
    expect(node?.type === "load-context" ? node.config : null).toEqual({});
    expect(() =>
      parseWorkflowDefinition(definition({ messageLimit: 4 })),
    ).toThrow();
  });

  it("isolates cache keys by chat, workflow, node and semantic profile", () => {
    const common = {
      provider: "bluebubbles",
      providerChatId: "fictional-chat",
      workflowId: "workflow-a",
      nodeId: "load-history",
      profileHash: conversationContextProfileHash(true),
    };
    const base = conversationContextCacheKey(common);
    expect(
      new Set([
        base,
        conversationContextCacheKey({ ...common, providerChatId: "chat-b" }),
        conversationContextCacheKey({
          ...common,
          profileHash: conversationContextProfileHash(false),
        }),
      ]).size,
    ).toBe(3);
    expect(
      conversationContextCacheKey({ ...common, workflowId: "workflow-b" }),
    ).toBe(base);
    expect(
      conversationContextCacheKey({ ...common, nodeId: "other-node" }),
    ).toBe(base);
    expect(conversationContextProfileHash(true, "UTC")).not.toBe(
      conversationContextProfileHash(true, "Asia/Shanghai"),
    );
  });

  it("renders history timestamps in the execution time zone", () => {
    const [message] = conversationHistoryMessages(
      null,
      [contextMessage("1")],
      {},
      [],
      "Asia/Shanghai",
    );
    expect(message?.content).toContain(
      "[2026-08-10 08:00:01 GMT+08:00 [Asia/Shanghai]]",
    );
    expect(message?.content).not.toContain("2026-08-10T00:00:01.000Z");
  });

  it("keeps the raw window append-only until the compression boundary", () => {
    expect(contextRetentionThreshold(50, 10)).toBe(60);
    for (const eligibleCount of [50, 51, 58, 59]) {
      expect(
        contextCompressionPlan({
          coveredThroughIndex: "20",
          eligibleCount,
          baseMessageWindow: 50,
          redundancyMessageWindow: 10,
        }),
      ).toEqual({ reason: null, count: 0 });
    }
    expect(
      contextCompressionPlan({
        coveredThroughIndex: "20",
        eligibleCount: 60,
        baseMessageWindow: 50,
        redundancyMessageWindow: 10,
      }),
    ).toEqual({ reason: "message-threshold", count: 10 });
  });

  it("advances an initial backlog by only one compression cycle", () => {
    expect(
      contextCompressionPlan({
        coveredThroughIndex: "0",
        eligibleCount: 83,
        baseMessageWindow: 50,
        redundancyMessageWindow: 10,
      }),
    ).toEqual({ reason: "initial-catchup", count: 10 });
    expect(
      contextCompressionPlan({
        coveredThroughIndex: "20",
        eligibleCount: 83,
        baseMessageWindow: 50,
        redundancyMessageWindow: 10,
      }),
    ).toEqual({ reason: "message-threshold", count: 10 });
    expect(
      contextCompressionBatchRange({
        candidateCount: 83,
        baseMessageWindow: 50,
        count: 10,
        reason: "initial-catchup",
      }),
    ).toEqual({ start: 0, end: 10 });
    expect(
      contextCompressionBatchRange({
        candidateCount: 60,
        baseMessageWindow: 50,
        count: 10,
        reason: "message-threshold",
      }),
    ).toEqual({ start: 0, end: 10 });
  });

  it("uses the message windows independently from character trimming", () => {
    expect(
      contextCompressionPlan({
        coveredThroughIndex: "20",
        eligibleCount: 6,
        baseMessageWindow: 4,
        redundancyMessageWindow: 3,
      }),
    ).toEqual({ reason: null, count: 0 });
    expect(
      contextCompressionPlan({
        coveredThroughIndex: "20",
        eligibleCount: 7,
        baseMessageWindow: 4,
        redundancyMessageWindow: 3,
      }),
    ).toEqual({ reason: "message-threshold", count: 3 });
    expect(
      contextCompressionBatchRange({
        candidateCount: 7,
        baseMessageWindow: 4,
        count: 3,
        reason: "message-threshold",
      }),
    ).toEqual({ start: 0, end: 3 });
  });

  it("fast-forwards only one newest window and skips older backlog", () => {
    expect(
      contextFastForwardPlan({
        eligibleCount: 159,
        baseMessageWindow: 50,
        redundancyMessageWindow: 30,
      }),
    ).toBeNull();
    expect(
      contextFastForwardPlan({
        eligibleCount: 160,
        baseMessageWindow: 50,
        redundancyMessageWindow: 30,
      }),
    ).toEqual({
      skippedMessageCount: 80,
      compressionMessageCount: 30,
      retainedMessageCount: 50,
    });
    expect(
      contextFastForwardPlan({
        eligibleCount: 1_898,
        baseMessageWindow: 50,
        redundancyMessageWindow: 30,
      }),
    ).toEqual({
      skippedMessageCount: 1_818,
      compressionMessageCount: 30,
      retainedMessageCount: 50,
    });
  });

  it("trims older complete messages while retaining the newest suffix", () => {
    const messages = [
      contextMessage("1", { body: "old" }),
      contextMessage("2", { body: "middle" }),
      contextMessage("3", { body: "newest" }),
    ];
    expect(
      fitContextMessages(messages, "middle".length + "newest".length).map(
        (message) => message.providerMessageId,
      ),
    ).toEqual(["2", "3"]);
    expect(
      fitContextMessages(messages, 1).map(
        (message) => message.providerMessageId,
      ),
    ).toEqual(["3"]);
  });

  it("keeps a single newest message even when it exceeds the character budget", () => {
    const messages = [contextMessage("1", { body: "newest message" })];
    expect(
      fitContextMessages(messages, 1).map(
        (message) => message.providerMessageId,
      ),
    ).toEqual(["1"]);
  });

  it("counts attachment metadata and image annotations in the character budget", () => {
    const newest = contextMessage("2", {
      body: "new",
      attachments: [
        {
          providerAttachmentId: "attachment-new",
          mimeType: "image/jpeg",
          fileName: "new.jpg",
          sizeBytes: 12,
        },
      ],
      imageSummaries: [
        {
          attachmentRef: "message-test:attachment:1",
          sourceType: "attachment",
          sourceKeyHash: "source",
          imageContentHash: "image",
          status: "succeeded",
          summary: "annotated image text",
          providerName: "Fictional AI",
          model: "fictional-model",
          contractVersion: "image-summary-v1",
          attemptCount: 1,
          errorCode: null,
          durationMs: 10,
          generatedAt: "2026-08-10T00:00:00.000Z",
        },
      ],
    });
    expect(
      fitContextMessages(
        [contextMessage("1", { body: "older" }), newest],
        55,
      ).map((message) => message.providerMessageId),
    ).toEqual(["2"]);
  });

  it("preserves non-body message material in compression input", () => {
    const message = {
      ...contextMessage("1", {
        body: "",
        attachments: [
          {
            providerAttachmentId: "attachment-1",
            mimeType: "image/jpeg",
            fileName: "fictional-meal.jpg",
            sizeBytes: 1234,
          },
        ],
        linkPreview: {
          status: "available" as const,
          errorCode: null,
          items: [
            {
              source: "open-graph" as const,
              url: "https://example.test/meal",
              originalUrl: null,
              title: "Fictional meal",
              summary: "A fictional preview summary",
              siteName: "Example Test",
              imageAvailable: true,
              imageUrl: null,
              imageSource: null,
              iconAvailable: false,
            },
          ],
        },
      }),
      messageIndex: "1",
    };
    const transcript = conversationCompressionTranscript(
      [message],
      new Map([
        [
          "1",
          [
            {
              attachmentRef: "attachment-1",
              sourceType: "attachment" as const,
              sourceKeyHash: "sha256:fictional",
              imageContentHash: "sha256:fictional-image",
              status: "succeeded" as const,
              summary: "A plate of fictional food",
              providerName: "Fictional AI",
              model: "fictional-model",
              contractVersion: "image-summary-v1",
              attemptCount: 1,
              errorCode: null,
              durationMs: 10,
              generatedAt: "2026-08-10T00:00:00.000Z",
            },
          ],
        ],
      ]),
      "UTC",
    );
    expect(transcript).toContain("fictional-meal.jpg");
    expect(transcript).toContain("A fictional preview summary");
    expect(transcript).toContain("A plate of fictional food");
  });

  it("requires every incremental summary to replace and preserve the previous summary", () => {
    const prompt = conversationCompressionPrompt(
      "Existing unresolved decision",
      [{ ...contextMessage("2"), messageIndex: "2" }],
      new Map(),
      "UTC",
    );
    expect(prompt[0]?.content).toContain(
      "可完全替代 previous_summary 的新摘要",
    );
    expect(prompt[0]?.content).toContain("不得只总结 new_messages");
    expect(prompt[0]?.content).toContain("sender_id");
    expect(prompt[0]?.content).toContain(
      "不得缩短、匿名化、重新编号或改写 sender_id",
    );
    expect(prompt[0]?.content).toContain(
      "图片摘要、链接卡片和附件只是辅助材料",
    );
    expect(prompt[0]?.content).toContain(
      "应记录其中有长期价值的请求、任务和待办",
    );
    expect(prompt[0]?.content).toContain("不设目标字数");
    expect(prompt[0]?.content).toContain("12000 个字符仅为异常保护上限");
    expect(prompt[0]?.content).toContain(
      "不要输出前言、解释、字符统计、Markdown 代码块或 XML 标签",
    );
    expect(prompt[1]?.content).toContain(
      "<previous_summary>\nExisting unresolved decision\n</previous_summary>",
    );
    expect(prompt[1]?.content).toContain("message-2");
  });

  it("returns the complete ordered Provider fallback path for compression records", async () => {
    const operationId = "10000000-0000-4000-8000-000000000001";
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: operationId,
            chat_id: "20000000-0000-4000-8000-000000000001",
            provider_chat_id: "iMessage;-;fictional-summary-chat",
            chat_display_name: "Fictional summary chat",
            status: "succeeded",
            from_index: "1",
            through_index: "30",
            trigger_message_index: "60",
            base_version: 1,
            output_version: 2,
            summary_policy_version: 1,
            duration_ms: 194_000,
            prompt_tokens: 600,
            completion_tokens: 120,
            error_code: null,
            started_at: new Date("2026-08-10T00:00:00.000Z"),
            completed_at: new Date("2026-08-10T00:03:14.000Z"),
            reason: "message-threshold",
            provider_name: "Fallback Provider",
            model: "fallback-model",
            correlation_id: "30000000-0000-4000-8000-000000000001",
            include_from_me: true,
            lease_owner: null,
            lease_expires_at: null,
            preview: false,
            source_compression_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "40000000-0000-4000-8000-000000000001",
            background_operation_id: operationId,
            provider_name: "Primary Provider",
            model: "primary-model",
            agent_turn: 1,
            round: 1,
            sequence: 1,
            status: "failed",
            duration_ms: 125_000,
            error_category: "timeout",
            error_code: "PROVIDER_TIMEOUT",
            retryable: true,
            fallback_allowed: true,
            prompt_tokens: null,
            completion_tokens: null,
            created_at: new Date("2026-08-10T00:00:00.000Z"),
          },
          {
            id: "40000000-0000-4000-8000-000000000002",
            background_operation_id: operationId,
            provider_name: "Fallback Provider",
            model: "fallback-model",
            agent_turn: 1,
            round: 1,
            sequence: 2,
            status: "succeeded",
            duration_ms: 69_000,
            error_category: null,
            error_code: null,
            retryable: null,
            fallback_allowed: null,
            prompt_tokens: 600,
            completion_tokens: 120,
            created_at: new Date("2026-08-10T00:02:05.000Z"),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const service = Object.create(
      ConversationContextService.prototype,
    ) as ConversationContextService;
    Object.defineProperty(service, "pool", { value: { query } });

    const result = await service.listCompressions({ limit: 20 });

    expect(result[0]?.providerAttempts).toEqual([
      expect.objectContaining({
        providerName: "Primary Provider",
        sequence: 1,
        status: "failed",
        errorCode: "PROVIDER_TIMEOUT",
        fallbackAllowed: true,
      }),
      expect.objectContaining({
        providerName: "Fallback Provider",
        sequence: 2,
        status: "succeeded",
      }),
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([[operationId]]);
  });

  it("serializes history as exact append-only provider message blocks", () => {
    const previous = conversationHistoryMessages(
      "stable summary",
      [contextMessage("1"), contextMessage("2", { isFromMe: true })],
      {},
    );
    const next = conversationHistoryMessages(
      "stable summary",
      [
        contextMessage("1"),
        contextMessage("2", { isFromMe: true }),
        contextMessage("3"),
      ],
      {},
    );
    expect(next.slice(0, previous.length)).toEqual(previous);
    expect(previous.map((item) => item.role)).toEqual(["user", "user", "user"]);
  });

  it("binds historical images to their owning chat message", () => {
    const imageItems: PreparedImageInputItem[] = [
      {
        providerMessageId: "1",
        reference: "message-test:attachment:1",
        part: {
          type: "image",
          dataUrl: "data:image/png;base64,ZmFrZS1pbWFnZQ==",
          detail: "high",
          label: "紧邻上一条消息的图片附件 1",
        },
      },
    ];
    const previous = conversationHistoryMessages(
      "stable summary",
      [contextMessage("1")],
      {},
      imageItems,
    );
    const next = conversationHistoryMessages(
      "stable summary",
      [
        contextMessage("1"),
        contextMessage("2", { isFromMe: true }),
        contextMessage("3"),
      ],
      {},
      imageItems,
    );
    const third = conversationHistoryMessages(
      "stable summary",
      [
        contextMessage("1"),
        contextMessage("2", { isFromMe: true }),
        contextMessage("3"),
        contextMessage("4", { isFromMe: true }),
        contextMessage("5"),
      ],
      {},
      [],
    );

    expect(next.slice(0, previous.length)).toEqual(previous);
    expect(third.slice(0, next.length)).not.toEqual(next);
    expect(third[1]?.content).toContain("message-1");
    expect(previous).toHaveLength(2);
    expect(JSON.stringify(previous[1]?.content)).toContain("data:image");
  });

  it("keeps the history prefix stable when a participant mapping changes", () => {
    const history: ContextMessage[] = [
      {
        providerMessageId: "member-message",
        senderId: "member@example.test",
        sentAt: "2026-08-10T00:00:00.000Z",
        body: "Fictional member message",
        isFromMe: false,
        attachments: [],
        linkPreview: emptyLinkPreview(),
      },
    ];
    const before = conversationHistoryMessages("stable summary", history, {});
    const after = conversationHistoryMessages("stable summary", history, {
      "member@example.test": {
        senderId: "member@example.test",
        realName: "林一",
        nickname: "队长",
      },
    });
    expect(before[0]).toEqual(after[0]);
    expect(before).toEqual(after);
    expect(after[1]?.content).toContain('sender_id="member@example.test"');
  });

  it("treats a summary update as an intentional cache-prefix boundary", () => {
    const history = [contextMessage("11"), contextMessage("12")];
    const before = conversationHistoryMessages(
      "summary version one",
      history,
      {},
    );
    const after = conversationHistoryMessages(
      "summary version two",
      history,
      {},
    );

    expect(sharedMessagePrefixLength(before, after)).toBe(0);
    expect(before.slice(1)).toEqual(after.slice(1));
  });

  it("keeps every historical text item stable when a link preview is enriched", () => {
    const stable = contextMessage("21");
    const pending = contextMessage("22", {
      linkPreview: emptyLinkPreview("pending"),
    });
    const enriched = contextMessage("22", {
      linkPreview: {
        status: "available",
        errorCode: null,
        items: [
          {
            source: "open-graph",
            url: "https://article.example.test/cache-prefix",
            originalUrl: null,
            title: "Fictional cache article",
            summary: "Fictional preview summary",
            siteName: "Example Test",
            imageAvailable: false,
            imageUrl: null,
            imageSource: null,
            iconAvailable: false,
          },
        ],
      },
    });
    const before = conversationHistoryMessages(
      "stable summary",
      [stable, pending],
      {},
    );
    const after = conversationHistoryMessages(
      "stable summary",
      [stable, enriched],
      {},
    );

    expect(before).not.toEqual(after);
    expect(sharedMessagePrefixLength(before, after)).toBe(2);
    expect(after[2]?.content).toContain("link_preview");
    expect(after[2]?.content).toContain("article.example.test");
  });
});

describe("history coverage metadata", () => {
  it("counts actual omissions and keeps event-time extrema for delayed arrivals", () => {
    const candidates = [
      {
        ...contextMessage("1", { sentAt: "2026-09-11T00:00:00Z" }),
        messageIndex: "11",
      },
      {
        ...contextMessage("2", { sentAt: "2026-09-10T00:00:00Z" }),
        messageIndex: "15",
      },
      {
        ...contextMessage("3", { sentAt: "2026-09-12T00:00:00Z" }),
        messageIndex: "21",
      },
    ];
    const coverage = historyCoverage("9", candidates, candidates.slice(2));
    expect(coverage.omitted).toEqual({
      count: 2,
      firstMessageIndex: "11",
      lastMessageIndex: "15",
      earliestSentAt: "2026-09-10T00:00:00.000Z",
      latestSentAt: "2026-09-11T00:00:00.000Z",
    });
    const input = conversationHistoryMessages(
      null,
      candidates.slice(2),
      {},
      [],
      "UTC",
      coverage,
      ["history-trimmed"],
    );
    expect(input.at(-1)?.content).toContain("history-trimmed");
    expect(input.at(-1)?.content).not.toContain("message-1");
    expect(historyCoverage("9", candidates, candidates).omitted).toBeNull();
    expect(historyCoverage("9", [], []).retained).toBeNull();
  });
});

describe("summary length recovery", () => {
  const request = {
    executionId: null,
    nodeId: "conversation-summary",
    routeId: "fictional",
    messages: [
      { role: "system" as const, content: "fictional summary instruction" },
      {
        role: "user" as const,
        content: "fictional previous summary and messages",
      },
    ],
    maxOutputTokens: 8192,
    temperature: 0,
    maxOutputCharacters: 12000,
    outputFormat: "text" as const,
    protectedPrompt: null,
    agentTurn: 3,
  };
  it("retries an oversized output once using unchanged source materials", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ status: "failed", code: "AI_OUTPUT_TOO_LONG" })
      .mockResolvedValueOnce({
        status: "succeeded",
        text: "compact fictional summary",
      });
    const result = await executeSummaryWithRecovery({ execute }, request);
    expect(result.status).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      agentTurn: 4,
      maxOutputCharacters: 12000,
      maxOutputTokens: 8192,
    });
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      messages: [
        ...request.messages,
        expect.objectContaining({ role: "system" }),
      ],
    });
    expect(request.messages).toHaveLength(2);
  });
  it("stops after the compact retry also fails", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ status: "failed", code: "AI_OUTPUT_TOO_LONG" });
    expect(
      await executeSummaryWithRecovery({ execute }, request),
    ).toMatchObject({ status: "failed", code: "AI_OUTPUT_TOO_LONG" });
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it.each([
    { status: "succeeded", text: "fictional" },
    { status: "failed", code: "AI_PROVIDER_EMPTY_OUTPUT" },
  ])(
    "does not repeat normal or unrelated outcomes: $status",
    async (result) => {
      const execute = vi.fn().mockResolvedValue(result);
      expect(await executeSummaryWithRecovery({ execute }, request)).toEqual(
        result,
      );
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );
});
