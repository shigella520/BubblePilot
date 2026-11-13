import { describe, expect, it, vi } from "vitest";

import { sha256 } from "../app/canonical-json.js";
import type { AiRepository } from "../modules/ai/ai-repository.js";
import { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import { OpenAiCompatibleClient } from "../modules/ai/openai-compatible-client.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import type { AiApiKind } from "../modules/ai/ai-types.js";
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
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";
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

async function imageAffinityFixture(
  apiKind: AiApiKind,
  options: {
    fallback?: boolean;
    affinity?: "session-id-header" | "disabled";
    responseStatus: (url: string, attempt: number) => number;
  },
) {
  const aiRepository = new InMemoryAiRepository();
  const providers = [];
  for (const name of options.fallback ? ["primary", "backup"] : ["primary"]) {
    const result = await aiRepository.createProvider({
      name,
      apiKind,
      baseUrl: `https://${name}.example.test/v1`,
      model: "fictional-vision",
      secretRef: "FICTIONAL_IMAGE_KEY",
      parameters: {},
      requestTimeoutMs: 5_000,
      enabled: true,
      capabilities: {
        functionCalling: false,
        hostedWebSearch: false,
        imageInput: true,
      },
      sessionAffinity: options.affinity ?? "session-id-header",
    });
    if (result.status !== "ok") throw new Error("Provider fixture failed.");
    providers.push(result.value);
    await aiRepository.updateProviderCapabilityProbe(result.value.id, {
      functionCalling: "unknown",
      hostedWebSearch: "unknown",
      imageInput: "verified",
      checkedAt: new Date(0).toISOString(),
    });
  }
  const route = await aiRepository.createRoute({
    name: "Fictional image route",
    providerIds: providers.map((provider) => provider.id),
    fallbackEnabled: options.fallback ?? false,
    retryPolicy: { maxRounds: 1, initialDelayMs: 0 },
    degradePolicy: { failureThreshold: 10, cooldownMs: 60_000 },
    enabled: true,
  });
  if (route.status !== "ok") throw new Error("Route fixture failed.");

  const requests: Array<{
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }> = [];
  const secrets = new EnvironmentSecretResolver({
    FICTIONAL_IMAGE_KEY: "fictional-secret",
  });
  const client = new OpenAiCompatibleClient(secrets, (url, init) => {
    const urlText =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (typeof init?.body !== "string") throw new Error("Expected JSON body.");
    requests.push({
      url: urlText,
      headers: new Headers(init?.headers),
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    const status = options.responseStatus(urlText, requests.length);
    const body =
      status === 200
        ? apiKind === "responses"
          ? { output_text: "一张虚构图片。" }
          : {
              choices: [
                {
                  message: { role: "assistant", content: "一张虚构图片。" },
                  finish_reason: "stop",
                },
              ],
            }
        : { error: { message: "Fictional provider unavailable" } };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  const routing = new AiRoutingService(aiRepository, client, secrets);
  const service = new ImageSummaryService(
    new MemorySummaryRepository(),
    aiRepository,
    routing,
    {
      loadForSummary: vi.fn().mockResolvedValue({
        status: "succeeded",
        contentHash: "sha256:fictional-image",
        part: {
          type: "image",
          dataUrl: "data:image/png;base64,ZmFrZQ==",
          detail: "high",
          label: "待摘要的消息图片",
        },
      }),
    } as unknown as NativeImageInputService,
  );
  return { service, providers, requests };
}

describe.each(["chat-completions", "responses"] as const)(
  "image summary session affinity (%s)",
  (apiKind) => {
    it("keeps the same job stable across retries and isolates another job", async () => {
      const { service, providers, requests } = await imageAffinityFixture(
        apiKind,
        { responseStatus: (_, attempt) => (attempt === 1 ? 503 : 200) },
      );
      const otherJob = {
        ...imageJob,
        id: "99999999-9999-4999-8999-999999999999",
      };

      await expect(service.process(imageJob, "worker-a")).resolves.toBe(false);
      await expect(
        service.process({ ...imageJob, attemptCount: 2 }, "worker-a"),
      ).resolves.toBe(true);
      await expect(service.process(otherJob, "worker-a")).resolves.toBe(true);

      expect(requests).toHaveLength(3);
      const ids = requests.map((request) =>
        request.headers.get("x-session-id"),
      );
      const scope = sha256(["image-summary", imageJob.id].join("\u0000"));
      expect(ids[0]).toBe(
        `bp_${sha256(`${providers[0]!.id}\u0000${scope}`).slice("sha256:".length)}`,
      );
      expect(ids[1]).toBe(ids[0]);
      expect(ids[2]).toMatch(/^bp_[a-f0-9]{64}$/u);
      expect(ids[2]).not.toBe(ids[0]);
      for (const [index, request] of requests.entries()) {
        expect(JSON.stringify(request.body)).not.toContain(imageJob.id);
        expect(JSON.stringify(request.body)).not.toContain(otherJob.id);
        if (apiKind === "responses") {
          expect(request.body.prompt_cache_key).toBe(ids[index]);
        } else {
          expect(request.body).not.toHaveProperty("prompt_cache_key");
        }
      }
    });

    it("uses a different session for each fallback provider", async () => {
      const { service, providers, requests } = await imageAffinityFixture(
        apiKind,
        {
          fallback: true,
          responseStatus: (url) => (url.includes("primary.") ? 503 : 200),
        },
      );

      await expect(service.process(imageJob, "worker-a")).resolves.toBe(true);

      expect(requests).toHaveLength(2);
      const scope = sha256(["image-summary", imageJob.id].join("\u0000"));
      const ids = requests.map((request) =>
        request.headers.get("x-session-id"),
      );
      for (const [index, request] of requests.entries()) {
        expect(request.url).toContain(index === 0 ? "primary." : "backup.");
        expect(ids[index]).toBe(
          `bp_${sha256(`${providers[index]!.id}\u0000${scope}`).slice("sha256:".length)}`,
        );
        if (apiKind === "responses") {
          expect(request.body.prompt_cache_key).toBe(ids[index]);
        }
      }
      expect(ids[0]).not.toBe(ids[1]);
    });

    it("does not automatically send a session when affinity is disabled", async () => {
      const { service, requests } = await imageAffinityFixture(apiKind, {
        affinity: "disabled",
        responseStatus: () => 200,
      });

      await expect(service.process(imageJob, "worker-a")).resolves.toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers.get("x-session-id")).toBeNull();
      expect(requests[0]!.body).not.toHaveProperty("prompt_cache_key");
    });
  },
);

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
    const result = conversationHistoryMessages([message], {}, [
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
    const unavailable = conversationHistoryMessages([message], {});

    expect(summarized[0]?.content).toContain('status="summarized"');
    expect(summarized[0]?.content).toContain(
      "画面里有 &lt;测试&gt; 与蓝色按钮。",
    );
    expect(unavailable[0]?.content).toContain('status="unavailable"');
    expect(unavailable[0]?.content).toContain("不得推断");
    expect(unavailable[0]?.content).not.toContain("历史图片已省略或不可用");
  });
});
