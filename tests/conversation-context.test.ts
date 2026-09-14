import { describe, expect, it } from "vitest";

import {
  fitContextMessages,
  historyCoverage,
  retainedWindowCount,
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

describe("raw conversation context contract", () => {
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

  it("renders history timestamps in the execution time zone", () => {
    const [message] = conversationHistoryMessages(
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

  it("serializes history as exact append-only provider message blocks", () => {
    const previous = conversationHistoryMessages(
      [contextMessage("1"), contextMessage("2", { isFromMe: true })],
      {},
    );
    const next = conversationHistoryMessages(
      [
        contextMessage("1"),
        contextMessage("2", { isFromMe: true }),
        contextMessage("3"),
      ],
      {},
    );
    expect(next.slice(0, previous.length)).toEqual(previous);
    expect(previous.map((item) => item.role)).toEqual(["user", "user"]);
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
      [contextMessage("1")],
      {},
      imageItems,
    );
    const next = conversationHistoryMessages(
      [
        contextMessage("1"),
        contextMessage("2", { isFromMe: true }),
        contextMessage("3"),
      ],
      {},
      imageItems,
    );
    const third = conversationHistoryMessages(
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
    expect(third[0]?.content).toContain("message-1");
    expect(previous).toHaveLength(1);
    expect(JSON.stringify(previous[0]?.content)).toContain("data:image");
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
    const before = conversationHistoryMessages(history, {});
    const after = conversationHistoryMessages(history, {
      "member@example.test": {
        senderId: "member@example.test",
        realName: "林一",
        nickname: "队长",
      },
    });
    expect(before[0]).toEqual(after[0]);
    expect(before).toEqual(after);
    expect(after[0]?.content).toContain('sender_id="member@example.test"');
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
    const before = conversationHistoryMessages([stable, pending], {});
    const after = conversationHistoryMessages([stable, enriched], {});

    expect(before).not.toEqual(after);
    expect(sharedMessagePrefixLength(before, after)).toBe(1);
    expect(after[1]?.content).toContain("link_preview");
    expect(after[1]?.content).toContain("article.example.test");
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
    const coverage = historyCoverage(candidates, candidates.slice(2));
    expect(coverage.omitted).toEqual({
      count: 2,
      firstMessageIndex: "11",
      lastMessageIndex: "15",
      earliestSentAt: "2026-09-10T00:00:00.000Z",
      latestSentAt: "2026-09-11T00:00:00.000Z",
    });
    const input = conversationHistoryMessages(
      candidates.slice(2),
      {},
      [],
      "UTC",
      coverage,
      ["history-trimmed"],
    );
    expect(input.at(-1)?.content).toContain("history-trimmed");
    expect(input.at(-1)?.content).not.toContain("message-1");
    expect(historyCoverage(candidates, candidates).omitted).toBeNull();
    expect(historyCoverage([], []).retained).toBeNull();
  });
});

it("advances by whole buffers using actual counts", () => {
  expect(
    [0, 3, 4, 5, 6, 7, 12].map((n) => retainedWindowCount(n, 3, 2)),
  ).toEqual([0, 3, 4, 3, 4, 3, 4]);
});

it("rejects explicit retired summary ports with the offending node", () => {
  const raw = definition({});
  const retired = {
    ...raw,
    nodes: [
      raw.nodes[0],
      {
        id: "render",
        type: "render-text",
        version: 1,
        config: { template: "{{context.outputs.load-history.summary}}" },
        onSuccess: "end",
      },
      raw.nodes[1],
    ],
  };
  expect(() => parseWorkflowDefinition(retired)).toThrow(/render.*summary/);
});
