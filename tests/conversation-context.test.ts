import { describe, expect, it } from "vitest";

import {
  CONTEXT_HARD_CHARACTER_LIMIT,
  contextAppendOnlyLimit,
  contextCompressionBatchRange,
  conversationContextCacheKey,
  conversationContextProfileHash,
  contextCompressionPlan,
} from "../modules/workflow/conversation-context-service.js";
import { conversationHistoryMessages } from "../modules/workflow/node-registry.js";
import type { ContextMessage } from "../modules/archive/archive-repository.js";
import type { PreparedImageInputItem } from "../modules/ai/native-image-input.js";
import { emptyLinkPreview } from "../modules/ingestion/link-preview.js";
import { parseWorkflowDefinition } from "../modules/workflow/workflow-definition.js";

const routeId = "11111111-1111-4111-8111-111111111111";

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
        config: {
          messageLimit: 10,
          characterLimit: 6_000,
          includeFromMe: true,
          ...config,
        },
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
  it("keeps existing load-context definitions summary-disabled", () => {
    const parsed = parseWorkflowDefinition(definition({}));
    const node = parsed.nodes[0];
    expect(node?.type).toBe("load-context");
    if (node?.type !== "load-context") return;
    expect(node.config).toMatchObject({
      summaryEnabled: false,
      compressionBatchSize: 10,
    });
  });

  it("requires a Provider route when summary is enabled", () => {
    expect(() =>
      parseWorkflowDefinition(definition({ summaryEnabled: true })),
    ).toThrow(/summary Provider route/u);
    expect(() =>
      parseWorkflowDefinition(
        definition({
          summaryEnabled: true,
          summaryProviderRouteId: routeId,
          compressionBatchSize: 5,
        }),
      ),
    ).not.toThrow();
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
        conversationContextCacheKey({ ...common, workflowId: "workflow-b" }),
        conversationContextCacheKey({ ...common, nodeId: "other-node" }),
        conversationContextCacheKey({
          ...common,
          profileHash: conversationContextProfileHash(false),
        }),
      ]).size,
    ).toBe(5);
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
    expect(contextAppendOnlyLimit(50, 10)).toBe(59);
    for (const eligibleCount of [50, 51, 58, 59]) {
      expect(
        contextCompressionPlan({
          coveredThroughIndex: "20",
          summaryCharacters: 200,
          eligibleCount,
          messageCharacterCounts: Array.from(
            { length: eligibleCount },
            () => 100,
          ),
          messageLimit: 50,
          characterLimit: 3_000,
          compressionBatchSize: 10,
        }),
      ).toEqual({ reason: null, count: 0 });
    }
    expect(
      contextCompressionPlan({
        coveredThroughIndex: "20",
        summaryCharacters: 200,
        eligibleCount: 60,
        messageCharacterCounts: Array.from({ length: 60 }, () => 100),
        messageLimit: 50,
        characterLimit: 3_000,
        compressionBatchSize: 10,
      }),
    ).toEqual({ reason: "message-threshold", count: 10 });
  });

  it("advances an initial backlog by only one compression cycle", () => {
    expect(
      contextCompressionPlan({
        coveredThroughIndex: "0",
        summaryCharacters: 0,
        eligibleCount: 83,
        messageCharacterCounts: Array.from({ length: 83 }, () => 100),
        messageLimit: 50,
        characterLimit: 3_000,
        compressionBatchSize: 10,
      }),
    ).toEqual({ reason: "initial-catchup", count: 10 });
    expect(
      contextCompressionPlan({
        coveredThroughIndex: "20",
        summaryCharacters: 300,
        eligibleCount: 83,
        messageCharacterCounts: Array.from({ length: 83 }, () => 100),
        messageLimit: 50,
        characterLimit: 3_000,
        compressionBatchSize: 10,
      }),
    ).toEqual({ reason: "initial-catchup", count: 10 });
    expect(
      contextCompressionBatchRange({
        candidateCount: 83,
        messageLimit: 50,
        count: 10,
        reason: "initial-catchup",
      }),
    ).toEqual({ start: 23, end: 33 });
    expect(
      contextCompressionBatchRange({
        candidateCount: 60,
        messageLimit: 50,
        count: 10,
        reason: "message-threshold",
      }),
    ).toEqual({ start: 0, end: 10 });
  });

  it("allows temporary overflow but compacts at the absolute safety limit", () => {
    expect(
      contextCompressionPlan({
        coveredThroughIndex: "20",
        summaryCharacters: 100,
        eligibleCount: 55,
        messageCharacterCounts: Array.from({ length: 55 }, () => 500),
        messageLimit: 50,
        characterLimit: 3_000,
        compressionBatchSize: 10,
      }),
    ).toEqual({ reason: null, count: 0 });
    const plan = contextCompressionPlan({
      coveredThroughIndex: "20",
      summaryCharacters: 100,
      eligibleCount: 55,
      messageCharacterCounts: Array.from({ length: 55 }, () => 600),
      messageLimit: 50,
      characterLimit: 3_000,
      compressionBatchSize: 10,
    });
    expect(100 + 55 * 600).toBeGreaterThan(CONTEXT_HARD_CHARACTER_LIMIT);
    expect(plan.reason).toBe("safety-limit");
    expect(plan.count).toBeGreaterThan(0);
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

  it("keeps historical text stable while images move to a trailing attachment section", () => {
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
    expect(third.slice(0, next.length)).toEqual(next);
    expect(previous).toHaveLength(2);
    expect(previous[1]?.content).not.toContain("data:image");
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

    expect(before).toEqual(after);
    expect(sharedMessagePrefixLength(before, after)).toBe(before.length);
    expect(after[2]?.content).toContain("link_preview_ref");
  });
});
