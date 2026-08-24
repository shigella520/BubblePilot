import { sha256 } from "../../app/canonical-json.js";
import type { ArchivedMessage } from "../archive/archive-repository.js";
import {
  attachmentImageReference,
  isImageAttachment,
  linkPreviewImageReference,
} from "./image-reference.js";
import type {
  ImageSummarySource,
  MessageImageSummary,
} from "./image-summary-types.js";

export type MessageImageMediaSource = {
  label: string;
  fileName: string | null;
  declaredMimeType: string | null;
  sizeBytes: number | null;
  source: ImageSummarySource;
};

export type MessageImageMediaView = {
  attachmentRef: string;
  sourceType: ImageSummarySource["sourceType"];
  label: string;
  fileName: string | null;
  declaredMimeType: string | null;
  sizeBytes: number | null;
  summaryStatus: MessageImageSummary["status"] | "not-created";
  summary: string | null;
  providerName: string | null;
  model: string | null;
  contractVersion: string | null;
  attemptCount: number;
  errorCode: string | null;
  durationMs: number | null;
  generatedAt: string | null;
  imageContentHash: string | null;
};

export function messageImageMediaSources(
  message: ArchivedMessage,
): readonly MessageImageMediaSource[] {
  const attachments = message.attachments.flatMap((attachment, index) =>
    isImageAttachment(attachment)
      ? [
          {
            label: `消息附件 ${index + 1}`,
            fileName: attachment.fileName,
            declaredMimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            source: {
              sourceType: "attachment" as const,
              sourceKey: attachment.providerAttachmentId,
              attachmentRef: attachmentImageReference(
                message.providerMessageId,
                index,
              ),
              attachment,
            },
          },
        ]
      : [],
  );
  const preview = message.linkPreview.items.find(
    (item) => item.imageUrl !== null,
  );
  return [
    ...attachments,
    ...(preview?.imageUrl === null || preview?.imageUrl === undefined
      ? []
      : [
          {
            label: "链接卡片主图",
            fileName: null,
            declaredMimeType: null,
            sizeBytes: null,
            source: {
              sourceType: "link-preview" as const,
              sourceKey: preview.imageUrl,
              attachmentRef: linkPreviewImageReference(
                message.providerMessageId,
              ),
              preview,
            },
          },
        ]),
  ];
}

export function messageImageMediaViews(
  sources: readonly MessageImageMediaSource[],
  summaries: readonly MessageImageSummary[],
): readonly MessageImageMediaView[] {
  return sources.map((item) => {
    const summary = summaries.find(
      (candidate) =>
        candidate.attachmentRef === item.source.attachmentRef &&
        candidate.sourceType === item.source.sourceType &&
        candidate.sourceKeyHash === sha256(item.source.sourceKey),
    );
    return {
      attachmentRef: item.source.attachmentRef,
      sourceType: item.source.sourceType,
      label: item.label,
      fileName: item.fileName,
      declaredMimeType: item.declaredMimeType,
      sizeBytes: item.sizeBytes,
      summaryStatus: summary?.status ?? "not-created",
      summary: summary?.summary ?? null,
      providerName: summary?.providerName ?? null,
      model: summary?.model ?? null,
      contractVersion: summary?.contractVersion ?? null,
      attemptCount: summary?.attemptCount ?? 0,
      errorCode: summary?.errorCode ?? null,
      durationMs: summary?.durationMs ?? null,
      generatedAt: summary?.generatedAt ?? null,
      imageContentHash: summary?.imageContentHash ?? null,
    };
  });
}
