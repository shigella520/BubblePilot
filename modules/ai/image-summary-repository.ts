import type {
  ImageSummaryCompletion,
  ImageSummaryJob,
  ImageSummarySource,
  ImageSummaryStatus,
  ImageSummaryDiagnostic,
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
  listDiagnosticsForExecution(
    executionId: string,
  ): Promise<readonly ImageSummaryDiagnostic[]>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
