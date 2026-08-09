import { describe, expect, it, vi } from "vitest";

import { ImageInputSettingsService } from "../modules/ai/image-input-settings-service.js";
import type { ImageInputSettingsRepository } from "../modules/ai/image-input-settings-repository.js";
import { NativeImageInputService } from "../modules/ai/native-image-input.js";
import type { ContextMessage } from "../modules/archive/archive-repository.js";
import { BlueBubblesSettingsService } from "../modules/integrations/bluebubbles/settings-service.js";
import type { BlueBubblesSettingsRepository } from "../modules/integrations/bluebubbles/settings-repository.js";
import { SettingsCipher } from "../modules/integrations/bluebubbles/settings-cipher.js";
import type { MessageEnvelope } from "../modules/ingestion/message-envelope.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=",
  "base64",
);

function imageSettings(
  overrides: Partial<{
    enabled: boolean;
    maxImageBytes: number;
    maxTotalBytes: number;
  }> = {},
): ImageInputSettingsService {
  const repository: ImageInputSettingsRepository = {
    find: () => Promise.resolve(null),
    save: () => Promise.resolve({ status: "conflict" }),
    isReady: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
  return new ImageInputSettingsService(repository, {
    enabled: overrides.enabled ?? true,
    includeAttachments: true,
    includeLinkPreviewImages: true,
    maxCurrentAttachments: 4,
    maxHistoryImages: 2,
    maxTotalImages: 6,
    maxImageBytes: overrides.maxImageBytes ?? 1024,
    maxTotalBytes: overrides.maxTotalBytes ?? 2048,
    fetchTimeoutMs: 1000,
    detail: "high",
  });
}

function blueBubbles(): BlueBubblesSettingsService {
  const repository: BlueBubblesSettingsRepository = {
    find: () => Promise.resolve(null),
    save: () => Promise.resolve({ status: "conflict" }),
    isReady: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
  return new BlueBubblesSettingsService(
    repository,
    new SettingsCipher("fictional-settings-key-32-characters"),
    {
      serverUrl: "https://bluebubbles.example.test",
      accessToken: "fictional-token",
      webhookSecret: "s".repeat(32),
      sendMethod: "private-api",
      requestTimeoutMs: 1000,
      linkPreviewEnabled: true,
      openGraphFallbackEnabled: true,
      openGraphTimeoutMs: 1000,
    },
  );
}

const envelope: MessageEnvelope = {
  schemaVersion: "3",
  eventId: "new-message:fictional",
  correlationId: "11111111-1111-4111-8111-111111111111",
  provider: "bluebubbles",
  chat: {
    providerChatId: "iMessage;-;fictional",
    type: "group",
    displayName: "Fictional group",
  },
  message: {
    providerMessageId: "fictional-message",
    senderId: "alice@example.test",
    sentAt: "2026-08-09T00:00:00.000Z",
    text: "兰博看看",
    contentType: "mixed",
    isFromMe: false,
    attachments: [
      {
        providerAttachmentId: "fictional-image",
        mimeType: "image/heic",
        fileName: "photo.heic",
        sizeBytes: 100,
      },
    ],
    linkPreview: { status: "not-requested", errorCode: null, items: [] },
    contentHash: "fictional-hash",
  },
  metadata: {
    isReplay: false,
    payloadHash: "fictional-payload-hash",
    eventType: "new-message",
    adapterVersion: "1",
  },
};

describe("NativeImageInputService", () => {
  it("downloads current and recent history attachments into bounded native parts", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(png, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      ),
    );
    const repository = new InMemoryAiRepository();
    const service = new NativeImageInputService(
      imageSettings(),
      blueBubbles(),
      repository,
      fetchImplementation,
    );
    const history: ContextMessage[] = [
      {
        providerMessageId: "history-image",
        senderId: "bob@example.test",
        sentAt: "2026-08-08T00:00:00.000Z",
        body: "",
        isFromMe: false,
        attachments: [
          {
            providerAttachmentId: "history-attachment",
            mimeType: "image/jpeg",
            fileName: "history.jpg",
            sizeBytes: 100,
          },
        ],
        linkPreview: { status: "not-requested", errorCode: null, items: [] },
      },
    ];

    const result = await service.prepare({
      executionId: "22222222-2222-4222-8222-222222222222",
      nodeId: "ai-node",
      envelope,
      history,
      includeHistory: true,
    });

    expect(result).toMatchObject({
      selectedCount: 2,
      failedCount: 0,
      totalBytes: png.length * 2,
    });
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0]?.dataUrl).toMatch(/^data:image\/png;base64,/u);
    expect(repository.imageInputs).toHaveLength(2);
    expect(repository.imageInputs[0]).toMatchObject({
      source: "attachment",
      status: "succeeded",
      actualMimeType: "image/png",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("skips an image that would exceed the aggregate byte limit", async () => {
    const largePng = Buffer.concat([png.subarray(0, 8), Buffer.alloc(1016)]);
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(largePng, { status: 200 })),
      );
    const repository = new InMemoryAiRepository();
    const service = new NativeImageInputService(
      imageSettings({ maxImageBytes: 1024, maxTotalBytes: 1024 }),
      blueBubbles(),
      repository,
      fetchImplementation,
    );

    const result = await service.prepare({
      executionId: "33333333-3333-4333-8333-333333333333",
      nodeId: "ai-node",
      envelope,
      history: [
        {
          providerMessageId: "history-image",
          senderId: "bob@example.test",
          sentAt: "2026-08-08T00:00:00.000Z",
          body: "",
          isFromMe: false,
          attachments: [
            {
              providerAttachmentId: "history-attachment",
              mimeType: "image/png",
              fileName: "history.png",
              sizeBytes: largePng.length,
            },
          ],
          linkPreview: {
            status: "not-requested",
            errorCode: null,
            items: [],
          },
        },
      ],
      includeHistory: true,
    });

    expect(result).toMatchObject({
      selectedCount: 1,
      failedCount: 0,
      skippedCount: 1,
      totalBytes: 1024,
    });
    expect(repository.imageInputs).toMatchObject([
      { status: "succeeded", bytes: 1024 },
      {
        status: "skipped",
        bytes: 1024,
        errorCode: "AI_IMAGE_TOTAL_BYTES_EXCEEDED",
      },
    ]);
  });

  it("rejects non-image response content without exposing it to the model", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not an image", { status: 200 }));
    const repository = new InMemoryAiRepository();
    const service = new NativeImageInputService(
      imageSettings(),
      blueBubbles(),
      repository,
      fetchImplementation,
    );

    const result = await service.prepare({
      executionId: "44444444-4444-4444-8444-444444444444",
      nodeId: "ai-node",
      envelope,
      history: [],
      includeHistory: false,
    });

    expect(result).toMatchObject({ selectedCount: 0, failedCount: 1 });
    expect(result.parts).toEqual([]);
    expect(repository.imageInputs).toMatchObject([
      { status: "failed", errorCode: "AI_IMAGE_INVALID_CONTENT" },
    ]);
  });

  it("does not resolve credentials or download images while globally disabled", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const service = new NativeImageInputService(
      imageSettings({ enabled: false }),
      blueBubbles(),
      undefined,
      fetchImplementation,
    );

    await expect(
      service.prepare({
        executionId: "55555555-5555-4555-8555-555555555555",
        nodeId: "ai-node",
        envelope,
        history: [],
        includeHistory: false,
      }),
    ).resolves.toEqual({
      parts: [],
      selectedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      totalBytes: 0,
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
