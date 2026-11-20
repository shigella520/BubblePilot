import type {
  ImageSummaryCompletion,
  ImageSummaryContentInput,
  ImageSummaryJob,
  ImageSummarySource,
  ImageSummaryStatus,
  MessageImageSummary,
} from "./image-summary-types.js";

export interface ImageSummaryRepository {
  enqueue(messageId: string, source: ImageSummarySource): Promise<boolean>;
  claimNext(input: {
    leaseOwner: string;
    leaseMs: number;
    maxAttempts: number;
  }): Promise<ImageSummaryJob | null>;
  renewLease(input: {
    jobId: string;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<boolean>;
  reuse(
    input: ImageSummaryContentInput & {
      durationMs: number;
      contentLeaseToken?: string;
    },
  ): Promise<boolean>;
  acquireContentLease(
    input: ImageSummaryContentInput,
  ): Promise<
    | { status: "acquired"; token: string }
    | { status: "waiting" }
    | { status: "invalid" }
  >;
  releaseContentLease(input: { jobId: string; token: string }): Promise<void>;
  canGenerate(
    input: ImageSummaryContentInput & { contentLeaseToken: string },
  ): Promise<boolean>;
  deferForContent(input: {
    jobId: string;
    leaseOwner: string;
  }): Promise<boolean>;
  complete(input: ImageSummaryCompletion): Promise<boolean>;
  fail(input: {
    jobId: string;
    leaseOwner: string;
    status: Extract<ImageSummaryStatus, "pending" | "failed" | "unavailable">;
    errorCode: string;
    durationMs: number;
    nextAttemptAt: Date;
  }): Promise<boolean>;
  listForMessageIds(
    messageIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly MessageImageSummary[]>>;
  listForProviderMessageIds(
    providerMessageIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly MessageImageSummary[]>>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
