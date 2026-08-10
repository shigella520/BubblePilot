import { describe, expect, it } from "vitest";

import {
  conversationContextCacheKey,
  conversationContextProfileHash,
} from "../modules/workflow/conversation-context-service.js";
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
});
