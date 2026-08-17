import type { LinkPreviewItem } from "../ingestion/link-preview.js";
import type { MessageAttachment } from "../ingestion/message-envelope.js";

export type ImageSummarySourceType = "attachment" | "link-preview";
export type ImageSummaryStatus =
  | "pending"
  | "processing"
  | "succeeded"
  | "failed"
  | "unavailable"
  | "redacted";

export interface MessageImageSummary {
  attachmentRef: string;
  sourceType: ImageSummarySourceType;
  sourceKeyHash: string;
  imageContentHash: string | null;
  status: ImageSummaryStatus;
  summary: string | null;
  providerName: string | null;
  model: string | null;
  contractVersion: string;
  attemptCount: number;
  errorCode: string | null;
  durationMs: number | null;
  generatedAt: string | null;
}

export type ImageSummaryDiagnostic = Omit<MessageImageSummary, "summary">;

export type ImageSummarySource =
  | {
      sourceType: "attachment";
      sourceKey: string;
      attachmentRef: string;
      attachment: MessageAttachment;
    }
  | {
      sourceType: "link-preview";
      sourceKey: string;
      attachmentRef: string;
      preview: LinkPreviewItem;
    };

export type ImageSummaryJob = ImageSummarySource & {
  id: string;
  messageId: string;
  providerMessageId: string;
  attemptCount: number;
};

export interface ImageSummaryCompletion {
  jobId: string;
  leaseOwner: string;
  imageContentHash: string;
  summary: string;
  providerId: string;
  providerName: string;
  model: string;
  durationMs: number;
}
