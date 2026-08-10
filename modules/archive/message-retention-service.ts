import { randomUUID } from "node:crypto";

import type { ArchiveRepository } from "./archive-repository.js";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

export interface MessageRetentionRunResult {
  correlationId: string;
  cutoffAt: string;
  redactedCount: number;
  batchLimitReached: boolean;
}

export interface MessageRetentionRuntimeStatus {
  enabled: true;
  retentionDays: number;
  running: boolean;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastRedactedCount: number;
  batchLimitReached: boolean;
}

export class MessageRetentionService {
  constructor(
    private readonly repository: ArchiveRepository,
    readonly retentionDays: number,
    private readonly batchLimit = 10_000,
    private readonly afterRedaction?: () => void | Promise<void>,
  ) {
    if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
      throw new Error("Message retention days must be a positive integer.");
    }
    if (!Number.isInteger(batchLimit) || batchLimit <= 0) {
      throw new Error("Message retention batch limit must be positive.");
    }
  }

  async run(now = new Date()): Promise<MessageRetentionRunResult> {
    const cutoff = new Date(
      now.getTime() - this.retentionDays * millisecondsPerDay,
    );
    const correlationId = randomUUID();
    const redactedCount = await this.repository.redactExpiredMessageContent({
      before: cutoff,
      now,
      limit: this.batchLimit,
      retentionDays: this.retentionDays,
      correlationId,
    });
    if (redactedCount > 0) await this.afterRedaction?.();
    return {
      correlationId,
      cutoffAt: cutoff.toISOString(),
      redactedCount,
      batchLimitReached: redactedCount === this.batchLimit,
    };
  }
}

export class MessageRetentionWorker {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private lastStartedAt: string | null = null;
  private lastCompletedAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastErrorAt: string | null = null;
  private lastRedactedCount = 0;
  private batchLimitReached = false;

  constructor(
    private readonly service: MessageRetentionService,
    private readonly intervalMs = 60 * 60 * 1_000,
  ) {
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("Message retention interval must be positive.");
    }
  }

  start(): void {
    if (this.timer !== null) return;
    this.trigger();
    this.timer = setInterval(() => this.trigger(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  runtimeStatus(): MessageRetentionRuntimeStatus {
    return {
      enabled: true,
      retentionDays: this.service.retentionDays,
      running: this.inFlight !== null,
      lastStartedAt: this.lastStartedAt,
      lastCompletedAt: this.lastCompletedAt,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastRedactedCount: this.lastRedactedCount,
      batchLimitReached: this.batchLimitReached,
    };
  }

  private trigger(): void {
    if (this.inFlight !== null) return;
    const startedAt = new Date();
    this.lastStartedAt = startedAt.toISOString();
    this.inFlight = this.service
      .run(startedAt)
      .then((result) => {
        this.lastSuccessAt = new Date().toISOString();
        this.lastRedactedCount = result.redactedCount;
        this.batchLimitReached = result.batchLimitReached;
      })
      .catch(() => {
        this.lastErrorAt = new Date().toISOString();
      })
      .finally(() => {
        this.lastCompletedAt = new Date().toISOString();
        this.inFlight = null;
      });
  }
}
