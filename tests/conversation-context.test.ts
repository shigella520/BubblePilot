import { describe, expect, it, vi } from "vitest";

import {
  contextRetentionThreshold,
  contextCompressionBatchRange,
  conversationContextCacheKey,
  conversationContextProfileHash,
  contextCompressionPlan,
  contextFastForwardPlan,
  ConversationSummaryWorker,
  type ConversationContextService,
  conversationCompressionPrompt,
  conversationCompressionTranscript,
  fitContextMessages,
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
  it("continues queued work when policy-rebuild recovery fails", async () => {
    const processQueued = vi.fn().mockResolvedValue(false);
    const worker = new ConversationSummaryWorker(
      {
        resumePendingPolicyRebuilds: vi
          .fn()
          .mockRejectedValue(new Error("fictional recovery failure")),
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

    expect(processQueued).toHaveBeenCalledOnce();
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
    expect(prompt[1]?.content).toContain(
      "<previous_summary>\nExisting unresolved decision\n</previous_summary>",
    );
    expect(prompt[1]?.content).toContain("message-2");
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
    expect(previous.map((item) => item.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
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
