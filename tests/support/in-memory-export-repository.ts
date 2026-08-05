import type { DataExportRepository } from "../../modules/export/export-repository.js";
import type {
  DataExportExecution,
  DataExportJob,
  DataExportMessage,
  DataExportMutationResult,
  DataExportOwner,
  DataExportPreviewResult,
  DataExportReadResult,
  DataExportScope,
} from "../../modules/export/export-types.js";

interface StoredJob {
  owner: DataExportOwner;
  job: DataExportJob;
}

export class InMemoryDataExportRepository implements DataExportRepository {
  readonly enabledChatIds = new Set<string>();
  readonly messages: DataExportMessage[] = [];
  readonly executions: DataExportExecution[] = [];
  readonly jobs = new Map<string, StoredJob>();

  createPreview(input: {
    id: string;
    owner: DataExportOwner;
    scope: DataExportScope;
    snapshotAt: Date;
    expiresAt: Date;
    maxRecords: number;
    maxEstimatedBytes: number;
  }): Promise<DataExportPreviewResult> {
    if (!this.enabledChatIds.has(input.scope.chatId)) {
      return Promise.resolve({ status: "scope-unavailable" });
    }
    const messages = input.scope.types.includes("messages")
      ? this.scopedMessages(input.scope, input.snapshotAt)
      : [];
    const executions = input.scope.types.includes("executions")
      ? this.scopedExecutions(input.scope, input.snapshotAt)
      : [];
    const estimatedBytes =
      messages.reduce(
        (total, message) =>
          total +
          Buffer.byteLength(message.body ?? "", "utf8") +
          Buffer.byteLength(JSON.stringify(message.attachments), "utf8") +
          512,
        0,
      ) +
      executions.length * 1_024;
    const recordCount = messages.length + executions.length;
    if (
      recordCount > input.maxRecords ||
      estimatedBytes > input.maxEstimatedBytes
    ) {
      return Promise.resolve({
        status: "too-large",
        recordCount,
        estimatedBytes,
      });
    }
    const job: DataExportJob = {
      id: input.id,
      scope: structuredClone(input.scope),
      snapshotAt: input.snapshotAt.toISOString(),
      messageCount: messages.length,
      executionCount: executions.length,
      recordCount,
      estimatedBytes,
      status: "awaiting-confirmation",
      expiresAt: input.expiresAt.toISOString(),
      confirmedAt: null,
      downloadedAt: null,
      revokedAt: null,
      createdAt: input.snapshotAt.toISOString(),
    };
    this.jobs.set(job.id, { owner: { ...input.owner }, job });
    return Promise.resolve({ status: "ok", value: structuredClone(job) });
  }

  listJobs(
    owner: DataExportOwner,
    now: Date,
    options: {
      limit: number;
      cursor: { timestamp: Date; id: string } | null;
    },
  ): Promise<readonly DataExportJob[]> {
    const cursorTimestamp = options.cursor?.timestamp.toISOString();
    return Promise.resolve(
      [...this.jobs.values()]
        .filter((stored) => this.sameOwner(stored.owner, owner))
        .map((stored) => this.currentJob(stored.job, now))
        .filter(
          (job) =>
            cursorTimestamp === undefined ||
            job.createdAt < cursorTimestamp ||
            (job.createdAt === cursorTimestamp &&
              job.id < (options.cursor?.id ?? "")),
        )
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            right.id.localeCompare(left.id),
        )
        .slice(0, options.limit)
        .map((job) => structuredClone(job)),
    );
  }

  confirmJob(input: {
    id: string;
    owner: DataExportOwner;
    expectedRecordCount: number;
    expectedSnapshotAt: Date;
    now: Date;
    expiresAt: Date;
  }): Promise<DataExportMutationResult> {
    const stored = this.owned(input.id, input.owner);
    if (stored === null) return Promise.resolve({ status: "not-found" });
    const current = this.currentJob(stored.job, input.now);
    if (current.status === "expired") {
      return Promise.resolve({ status: "expired" });
    }
    if (current.status !== "awaiting-confirmation") {
      return Promise.resolve({
        status: "conflict",
        reason: "The export is no longer awaiting confirmation.",
      });
    }
    if (
      current.recordCount !== input.expectedRecordCount ||
      current.snapshotAt !== input.expectedSnapshotAt.toISOString()
    ) {
      return Promise.resolve({
        status: "conflict",
        reason: "The export preview changed; create a new preview.",
      });
    }
    stored.job = {
      ...stored.job,
      status: "ready",
      confirmedAt: input.now.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    };
    return Promise.resolve({
      status: "ok",
      value: structuredClone(stored.job),
    });
  }

  revokeJob(input: {
    id: string;
    owner: DataExportOwner;
    now: Date;
  }): Promise<DataExportMutationResult> {
    const stored = this.owned(input.id, input.owner);
    if (stored === null) return Promise.resolve({ status: "not-found" });
    const current = this.currentJob(stored.job, input.now);
    if (current.status === "expired") {
      return Promise.resolve({ status: "expired" });
    }
    if (current.status !== "revoked") {
      stored.job = {
        ...stored.job,
        status: "revoked",
        revokedAt: input.now.toISOString(),
      };
    }
    return Promise.resolve({
      status: "ok",
      value: structuredClone(stored.job),
    });
  }

  readJob(input: {
    id: string;
    owner: DataExportOwner;
    now: Date;
  }): Promise<DataExportReadResult> {
    const stored = this.owned(input.id, input.owner);
    if (stored === null) return Promise.resolve({ status: "not-found" });
    const job = this.currentJob(stored.job, input.now);
    if (job.status === "expired") {
      return Promise.resolve({ status: "expired" });
    }
    if (job.status !== "ready") {
      return Promise.resolve({ status: "not-ready" });
    }
    if (!this.enabledChatIds.has(job.scope.chatId)) {
      return Promise.resolve({ status: "scope-unavailable" });
    }
    const snapshotAt = new Date(job.snapshotAt);
    const messages = job.scope.types.includes("messages")
      ? this.scopedMessages(job.scope, snapshotAt)
      : [];
    const executions = job.scope.types.includes("executions")
      ? this.scopedExecutions(job.scope, snapshotAt)
      : [];
    if (
      messages.length !== job.messageCount ||
      executions.length !== job.executionCount
    ) {
      return Promise.resolve({ status: "conflict" });
    }
    const downloadedJob = {
      ...stored.job,
      downloadedAt: stored.job.downloadedAt ?? input.now.toISOString(),
    };
    stored.job = downloadedJob;
    return Promise.resolve({
      status: "ok",
      job: structuredClone(downloadedJob),
      content: {
        messages: structuredClone(messages),
        executions: structuredClone(executions),
      },
    });
  }

  isReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async close(): Promise<void> {}

  private owned(id: string, owner: DataExportOwner): StoredJob | null {
    const stored = this.jobs.get(id);
    return stored !== undefined && this.sameOwner(stored.owner, owner)
      ? stored
      : null;
  }

  private sameOwner(left: DataExportOwner, right: DataExportOwner): boolean {
    return (
      left.actorType === right.actorType &&
      left.actorSessionId === right.actorSessionId
    );
  }

  private currentJob(job: DataExportJob, now: Date): DataExportJob {
    return job.status !== "revoked" &&
      Date.parse(job.expiresAt) <= now.getTime()
      ? { ...job, status: "expired" }
      : job;
  }

  private scopedMessages(
    scope: DataExportScope,
    snapshotAt: Date,
  ): DataExportMessage[] {
    return this.messages.filter(
      (message) =>
        message.chatId === scope.chatId &&
        Date.parse(message.sentAt) >= Date.parse(scope.sentFrom) &&
        Date.parse(message.sentAt) <= Date.parse(scope.sentTo) &&
        Date.parse(message.createdAt) <= snapshotAt.getTime(),
    );
  }

  private scopedExecutions(
    scope: DataExportScope,
    snapshotAt: Date,
  ): DataExportExecution[] {
    const sourceMessageIds = new Set(
      this.scopedMessages(scope, snapshotAt).map((message) => message.id),
    );
    return this.executions.filter(
      (execution) =>
        sourceMessageIds.has(execution.sourceMessageId) &&
        Date.parse(execution.createdAt) <= snapshotAt.getTime(),
    );
  }
}
