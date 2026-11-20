import { describe, expect, it } from "vitest";

import { sha256 } from "../app/canonical-json.js";
import {
  messageImageMediaSources,
  messageImageMediaViews,
} from "../modules/ai/message-image-media.js";
import type { MessageImageSummary } from "../modules/ai/image-summary-types.js";
import type { ArchivedMessage } from "../modules/archive/archive-repository.js";

const message: ArchivedMessage = {
  id: "11111111-1111-4111-8111-111111111111",
  providerMessageId: "fictional-media-message",
  senderId: "alice@example.test",
  sentAt: "2026-08-17T00:00:00.000Z",
  body: "两张素材",
  contentType: "mixed",
  isFromMe: false,
  attachments: [
    {
      providerAttachmentId: "fictional-document",
      mimeType: "application/pdf",
      fileName: "fictional.pdf",
      sizeBytes: 100,
    },
    {
      providerAttachmentId: "fictional-image",
      mimeType: "image/png",
      fileName: "fictional.png",
      sizeBytes: 200,
    },
  ],
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
  linkPreviewDiagnostics: [],
  linkPreviewFetchedAt: "2026-08-17T00:00:01.000Z",
  contentRedactedAt: null,
  createdAt: "2026-08-17T00:00:00.000Z",
};

describe("message image media", () => {
  it("keeps attachment indexes stable and separates link preview images", () => {
    const sources = messageImageMediaSources(message);

    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      fileName: "fictional.png",
      source: {
        sourceType: "attachment",
        sourceKey: "fictional-image",
      },
    });
    expect(sources[0]?.source.attachmentRef).toContain(":attachment:2");
    expect(sources[1]).toMatchObject({
      label: "链接卡片主图",
      source: {
        sourceType: "link-preview",
        sourceKey: "https://cdn.example.test/cover.png",
      },
    });
  });

  it("matches summaries by stable reference, source type, and source hash", () => {
    const sources = messageImageMediaSources(message);
    const attachment = sources[0]!;
    const summary: MessageImageSummary = {
      attachmentRef: attachment.source.attachmentRef,
      sourceType: "attachment",
      sourceKeyHash: sha256(attachment.source.sourceKey),
      imageContentHash: "sha256:fictional-content",
      status: "succeeded",
      summary: "一张虚构的蓝色界面截图。",
      providerName: "Vision provider",
      model: "fictional-vision",
      contractVersion: "image-summary-v1",
      attemptCount: 1,
      errorCode: null,
      durationMs: 12,
      generatedAt: "2026-08-17T00:00:02.000Z",
    };

    const views = messageImageMediaViews(sources, [summary]);

    expect(views[0]).toMatchObject({
      summaryStatus: "succeeded",
      summary: "一张虚构的蓝色界面截图。",
      providerName: "Vision provider",
      resultOrigin: "legacy",
      providerAttemptCount: 0,
      reusedAt: null,
    });
    expect(views[1]).toMatchObject({
      sourceType: "link-preview",
      summaryStatus: "not-created",
      summary: null,
    });
  });
  it("exposes cached provenance without importing source attempts and keeps zero calls", () => {
    const sources = messageImageMediaSources(message);
    const source = sources[0]!.source;
    const cached: MessageImageSummary = {
      attachmentRef: source.attachmentRef,
      sourceType: source.sourceType,
      sourceKeyHash: sha256(source.sourceKey),
      status: "succeeded",
      summary: "虚构缓存摘要",
      providerName: "Original provider",
      model: "fictional",
      contractVersion: "image-summary-v1",
      attemptCount: 1,
      providerAttemptCount: 0,
      resultOrigin: "cache",
      imageContentHash: "sha256:fixture",
      errorCode: null,
      durationMs: 3,
      generatedAt: "2026-08-17T00:00:02.000Z",
      reusedAt: "2026-08-18T00:00:02.000Z",
    };
    expect(messageImageMediaViews(sources, [cached])[0]).toMatchObject({
      resultOrigin: "cache",
      providerAttemptCount: 0,
      generatedAt: cached.generatedAt,
      reusedAt: cached.reusedAt,
    });
  });
});
