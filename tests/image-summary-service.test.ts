import { describe, expect, it, vi } from "vitest";

import { sha256 } from "../app/canonical-json.js";
import type { AiRepository } from "../modules/ai/ai-repository.js";
import type { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import {
  ImageSummaryService,
  ImageSummaryWorker,
} from "../modules/ai/image-summary-service.js";
import type { ImageSummaryRepository } from "../modules/ai/image-summary-repository.js";
import type {
  ImageSummaryCompletion,
  ImageSummaryJob,
  ImageSummarySource,
  MessageImageSummary,
} from "../modules/ai/image-summary-types.js";
import type { NativeImageInputService } from "../modules/ai/native-image-input.js";
import { conversationHistoryMessages } from "../modules/workflow/node-registry.js";
import type { ContextMessage } from "../modules/archive/archive-repository.js";
import type { MessageEnvelope } from "../modules/ingestion/message-envelope.js";
import { IngestionService } from "../modules/ingestion/ingestion-service.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import { InMemoryArchiveRepository } from "./support/in-memory-archive-repository.js";
import {
  groupAttachmentWebhook,
  newMessageWebhook,
} from "./fixtures/bluebubbles.js";

class MemorySummaryRepository implements ImageSummaryRepository {
  readonly sources = new Map<string, ImageSummarySource>();
  readonly completions: ImageSummaryCompletion[] = [];
  readonly failures: Array<{ status: string; errorCode: string }> = [];

  enqueue(messageId: string, source: ImageSummarySource): Promise<boolean> {
    const key = `${messageId}:${source.sourceType}:${source.sourceKey}`;
    const created = !this.sources.has(key);
    this.sources.set(key, source);
    return Promise.resolve(created);
  }

  claimNext(): Promise<ImageSummaryJob | null> {
    return Promise.resolve(null);
  }

  renewLease(): Promise<boolean> {
    return Promise.resolve(true);
  }

  complete(input: ImageSummaryCompletion): Promise<boolean> {
    this.completions.push(input);
    return Promise.resolve(true);
  }

  fail(input: {
    status: "pending" | "failed" | "unavailable";
    errorCode: string;
  }): Promise<boolean> {
    this.failures.push(input);
    return Promise.resolve(true);
  }

  listForMessageIds(): Promise<
    ReadonlyMap<string, readonly MessageImageSummary[]>
  > {
    return Promise.resolve(new Map());
  }

  listForProviderMessageIds(): Promise<
    ReadonlyMap<string, readonly MessageImageSummary[]>
  > {
    return Promise.resolve(new Map());
  }

  listDiagnosticsForExecution(): Promise<[]> {
    return Promise.resolve([]);
  }

  isReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const imageJob: ImageSummaryJob = {
  id: "11111111-1111-4111-8111-111111111111",
  messageId: "22222222-2222-4222-8222-222222222222",
  providerMessageId: "fictional-message",
  attemptCount: 1,
  sourceType: "attachment",
  sourceKey: "fictional-image",
  attachmentRef: "message-sha256:attachment:1",
  attachment: {
    providerAttachmentId: "fictional-image",
    mimeType: "image/png",
    fileName: "fictional.png",
    sizeBytes: 100,
  },
};

function imageRouteRepository(): Pick<
  AiRepository,
  "listRoutes" | "getRouteSnapshot"
> {
  const route = {
    id: "33333333-3333-4333-8333-333333333333",
    versionId: "44444444-4444-4444-8444-444444444444",
    name: "Default image route",
    providerIds: ["55555555-5555-4555-8555-555555555555"],
    fallbackEnabled: true,
    retryPolicy: { maxRounds: 2, initialDelayMs: 0 },
    degradePolicy: { failureThreshold: 3, cooldownMs: 60_000 },
    enabled: true,
    version: 1,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
  };
  return {
    listRoutes: () => Promise.resolve([route]),
    getRouteSnapshot: () =>
      Promise.resolve({
        route,
        providers: [
          {
            id: route.providerIds[0]!,
            name: "Vision provider",
            apiKind: "responses",
            baseUrl: "https://ai.example.test/v1",
            model: "fictional-vision",
            secret: "fictional-secret",
            parameters: {},
            requestTimeoutMs: 30_000,
            enabled: true,
            capabilities: {
              functionCalling: false,
              hostedWebSearch: false,
              imageInput: true,
            },
            capabilityProbe: {
              functionCalling: "unknown",
              hostedWebSearch: "unknown",
              imageInput: "verified",
              checkedAt: "2026-08-17T00:00:00.000Z",
            },
            sortOrder: 1,
            version: 1,
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:00.000Z",
          },
        ],
      }),
  };
}

describe("image summary background processing", () => {
  it("uses a verified image route without history, tools, search, or text fallback", async () => {
    const repository = new MemorySummaryRepository();
    const execute = vi.fn().mockResolvedValue({
      status: "succeeded",
      text: "一张虚构的蓝色界面截图。",
      toolCalls: [],
      providerId: "55555555-5555-4555-8555-555555555555",
      providerName: "Vision provider",
      providerVersion: 1,
      model: "fictional-vision",
      routeVersion: 1,
      round: 1,
      attemptCount: 1,
      durationMs: 8,
      diagnostics: null,
    });
    const loadForSummary = vi.fn().mockResolvedValue({
      status: "succeeded",
      contentHash: "sha256:fictional-image",
      part: {
        type: "image",
        dataUrl: "data:image/png;base64,ZmFrZQ==",
        detail: "high",
        label: "待摘要的消息图片",
      },
    });
    const service = new ImageSummaryService(
      repository,
      imageRouteRepository(),
      { execute } as unknown as AiRoutingService,
      { loadForSummary } as unknown as NativeImageInputService,
    );

    await expect(service.process(imageJob, "worker-a")).resolves.toBe(true);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: null,
        nodeId: "image-summary",
        purpose: "image-summary",
        backgroundOperationId: imageJob.id,
        allowImageDegrade: false,
      }),
    );
    const request = execute.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(request.messages).toHaveLength(2);
    expect(request.messages[1]?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image" })]),
    );
    expect(repository.completions).toMatchObject([
      {
        jobId: imageJob.id,
        summary: "一张虚构的蓝色界面截图。",
        imageContentHash: "sha256:fictional-image",
      },
    ]);
  });

  it("retries a temporarily unavailable image route before failing permanently", async () => {
    const repository = new MemorySummaryRepository();
    const service = new ImageSummaryService(
      repository,
      {
        listRoutes: () => Promise.resolve([]),
        getRouteSnapshot: () => Promise.resolve(null),
      },
      { execute: vi.fn() } as unknown as AiRoutingService,
      { loadForSummary: vi.fn() } as unknown as NativeImageInputService,
      3,
    );

    await expect(service.process(imageJob, "worker-a")).resolves.toBe(false);
    await expect(
      service.process({ ...imageJob, attemptCount: 3 }, "worker-a"),
    ).resolves.toBe(false);

    expect(repository.failures).toMatchObject([
      {
        status: "pending",
        errorCode: "IMAGE_SUMMARY_ROUTE_UNAVAILABLE",
      },
      {
        status: "failed",
        errorCode: "IMAGE_SUMMARY_ROUTE_UNAVAILABLE",
      },
    ]);
  });

  it("marks an unreadable image unavailable without calling a Provider", async () => {
    const repository = new MemorySummaryRepository();
    const execute = vi.fn();
    const service = new ImageSummaryService(
      repository,
      imageRouteRepository(),
      { execute } as unknown as AiRoutingService,
      {
        loadForSummary: vi.fn().mockResolvedValue({
          status: "failed",
          errorCode: "AI_IMAGE_INVALID_CONTENT",
          retryable: false,
        }),
      } as unknown as NativeImageInputService,
    );

    await expect(service.process(imageJob, "worker-a")).resolves.toBe(false);

    expect(execute).not.toHaveBeenCalled();
    expect(repository.failures).toMatchObject([
      {
        status: "unavailable",
        errorCode: "IMAGE_SUMMARY_IMAGE_INVALID_CONTENT",
      },
    ]);
  });

  it("deduplicates image attachments and link preview main images by persisted source", async () => {
    const repository = new MemorySummaryRepository();
    const worker = new ImageSummaryWorker(
      repository,
      { process: vi.fn() } as unknown as ImageSummaryService,
      60_000,
    );
    const envelope: MessageEnvelope = {
      schemaVersion: "3",
      eventId: "fictional-event",
      correlationId: "66666666-6666-4666-8666-666666666666",
      provider: "bluebubbles",
      chat: {
        providerChatId: "iMessage;-;fictional",
        type: "group",
        displayName: "Fictional group",
      },
      message: {
        providerMessageId: "fictional-message",
        senderId: "alice@example.test",
        sentAt: "2026-08-17T00:00:00.000Z",
        text: "看看",
        contentType: "mixed",
        isFromMe: false,
        attachments: [imageJob.attachment],
        linkPreview: { status: "not-requested", errorCode: null, items: [] },
        contentHash: "fictional-content",
      },
      metadata: {
        isReplay: false,
        payloadHash: "fictional-payload",
        eventType: "new-message",
        adapterVersion: "1",
      },
    };

    await worker.enqueueAttachments(imageJob.messageId, envelope);
    await worker.enqueueAttachments(imageJob.messageId, envelope);
    await worker.enqueueLinkPreviews({
      messageId: imageJob.messageId,
      providerMessageId: envelope.message.providerMessageId,
      linkPreview: {
        status: "available",
        errorCode: null,
        items: [
          {
            source: "open-graph",
            url: "https://example.test/article",
            originalUrl: null,
            title: "Fictional article",
            summary: null,
            siteName: "Example",
            imageAvailable: true,
            imageUrl: "https://cdn.example.test/cover.png",
            imageSource: "open-graph",
            iconAvailable: false,
          },
        ],
      },
    });

    expect(repository.sources).toHaveLength(2);
  });
});

describe("image summary ingestion hooks", () => {
  it("enqueues attachments after archive persistence without blocking automation", async () => {
    const repository = new InMemoryArchiveRepository();
    const enqueueAttachments = vi
      .fn<(messageId: string, envelope: MessageEnvelope) => Promise<void>>()
      .mockReturnValue(new Promise(() => undefined));
    const service = new IngestionService(
      new BlueBubblesWebhookAdapter(),
      repository,
      new Set(["iMessage;+;fictional-group"]),
      undefined,
      {
        enqueueAttachments,
        enqueueLinkPreviews: vi.fn().mockResolvedValue(undefined),
      },
    );

    const result = await service.ingest(
      groupAttachmentWebhook(),
      "77777777-7777-4777-8777-777777777777",
    );

    expect(result.result.status).toBe("archived");
    expect(enqueueAttachments).toHaveBeenCalledTimes(1);
    expect(enqueueAttachments.mock.calls[0]?.[0]).toBe(result.result.messageId);
    expect(
      enqueueAttachments.mock.calls[0]?.[1].message.providerMessageId,
    ).toBe("fake-message-guid-attachment");
  });

  it("enqueues a link preview main image only after the persisted preview wins", async () => {
    const repository = new InMemoryArchiveRepository();
    const enqueueLinkPreviews = vi.fn().mockResolvedValue(undefined);
    const preview = {
      status: "available" as const,
      errorCode: null,
      items: [
        {
          source: "open-graph" as const,
          url: "https://example.test/article",
          originalUrl: null,
          title: "Fictional article",
          summary: "Fictional summary",
          siteName: "Example",
          imageAvailable: true,
          imageUrl: "https://cdn.example.test/cover.png",
          imageSource: "open-graph" as const,
          iconAvailable: false,
        },
      ],
    };
    const service = new IngestionService(
      new BlueBubblesWebhookAdapter(),
      repository,
      new Set(["iMessage;-;fictional-chat"]),
      {
        enrich: vi
          .fn()
          .mockResolvedValue({ linkPreview: preview, diagnostics: [] }),
      },
      {
        enqueueAttachments: vi.fn().mockResolvedValue(undefined),
        enqueueLinkPreviews,
      },
    );

    const result = await service.ingest(
      newMessageWebhook({ text: "https://example.test/article" }),
      "88888888-8888-4888-8888-888888888888",
    );

    expect(enqueueLinkPreviews).toHaveBeenCalledWith({
      messageId: result.result.messageId,
      providerMessageId: "fake-message-guid-001",
      linkPreview: preview,
    });
  });
});

describe("history image summary payload", () => {
  const message: ContextMessage = {
    providerMessageId: "history-message",
    senderId: "alice@example.test",
    sentAt: "2026-08-17T00:00:00.000Z",
    body: "这张图",
    isFromMe: false,
    attachments: [
      {
        providerAttachmentId: "history-image",
        mimeType: "image/png",
        fileName: "history.png",
        sizeBytes: 100,
      },
    ],
    linkPreview: { status: "not-requested", errorCode: null, items: [] },
  };

  it("keeps a provided image native and marks its stable reference", () => {
    const result = conversationHistoryMessages(null, [message], {}, [
      {
        providerMessageId: message.providerMessageId,
        reference: `message-${sha256(message.providerMessageId).slice(0, 16)}:attachment:1`,
        part: {
          type: "image",
          dataUrl: "data:image/png;base64,ZmFrZQ==",
          detail: "high",
          label: "消息附件 1",
        },
      },
    ]);

    const content = result[0]?.content;
    if (content === undefined || typeof content === "string")
      throw new Error("Expected native image parts.");
    const text = content.find((part) => part.type === "text");
    expect(text?.type === "text" ? text.text : "").toContain(
      'status="provided"',
    );
    expect(content.some((part) => part.type === "image")).toBe(true);
  });

  it("inlines a saved summary or a stable unavailable statement", () => {
    const attachmentRef = `message-${sha256(message.providerMessageId).slice(0, 16)}:attachment:1`;
    const summarized = conversationHistoryMessages(
      null,
      [
        {
          ...message,
          imageSummaries: [
            {
              attachmentRef,
              sourceType: "attachment",
              sourceKeyHash: sha256("history-image"),
              imageContentHash: "sha256:content",
              status: "succeeded",
              summary: "画面里有 <测试> 与蓝色按钮。",
              providerName: "Vision provider",
              model: "fictional-vision",
              contractVersion: "image-summary-v1",
              attemptCount: 1,
              errorCode: null,
              durationMs: 10,
              generatedAt: "2026-08-17T00:00:01.000Z",
            },
          ],
        },
      ],
      {},
    );
    const unavailable = conversationHistoryMessages(null, [message], {});

    expect(summarized[0]?.content).toContain('status="summarized"');
    expect(summarized[0]?.content).toContain(
      "画面里有 &lt;测试&gt; 与蓝色按钮。",
    );
    expect(unavailable[0]?.content).toContain('status="unavailable"');
    expect(unavailable[0]?.content).toContain("不得推断");
    expect(unavailable[0]?.content).not.toContain("历史图片已省略或不可用");
  });
});
