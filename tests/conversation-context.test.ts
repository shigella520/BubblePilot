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
    const message = (id: string, isFromMe = false): ContextMessage => ({
      providerMessageId: id,
      senderId: isFromMe ? null : "user@example.test",
      sentAt: `2026-08-10T00:00:0${id}.000Z`,
      body: `message-${id}`,
      isFromMe,
      attachments: [],
      linkPreview: emptyLinkPreview(),
    });
    const previous = conversationHistoryMessages(
      "stable summary",
      [message("1"), message("2", true)],
      {},
    );
    const next = conversationHistoryMessages(
      "stable summary",
      [message("1"), message("2", true), message("3")],
      {},
    );
    expect(next.slice(0, previous.length)).toEqual(previous);
    expect(previous.map((item) => item.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
  });
});
