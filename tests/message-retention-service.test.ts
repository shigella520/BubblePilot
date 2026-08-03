import { describe, expect, it, vi } from "vitest";

import type { ArchiveRepository } from "../modules/archive/archive-repository.js";
import {
  MessageRetentionService,
  MessageRetentionWorker,
} from "../modules/archive/message-retention-service.js";

describe("MessageRetentionService", () => {
  it("uses archive age, a bounded batch, and a correlation identifier", async () => {
    const redactExpiredMessageContent = vi.fn().mockResolvedValue(2);
    const repository = {
      redactExpiredMessageContent,
    } as unknown as ArchiveRepository;
    const service = new MessageRetentionService(repository, 90, 2);
    const now = new Date("2026-08-03T12:00:00.000Z");

    const result = await service.run(now);

    expect(redactExpiredMessageContent).toHaveBeenCalledWith({
      before: new Date("2026-05-05T12:00:00.000Z"),
      now,
      limit: 2,
      retentionDays: 90,
      correlationId: result.correlationId,
    });
    expect(result).toMatchObject({
      cutoffAt: "2026-05-05T12:00:00.000Z",
      redactedCount: 2,
      batchLimitReached: true,
    });
    expect(result.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("exposes failures without allowing overlapping scheduled runs", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const redactExpiredMessageContent = vi
      .fn()
      .mockImplementationOnce(async () => {
        await pending;
        throw new Error("Fictional retention failure.");
      });
    const repository = {
      redactExpiredMessageContent,
    } as unknown as ArchiveRepository;
    const worker = new MessageRetentionWorker(
      new MessageRetentionService(repository, 30),
      1,
    );

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(redactExpiredMessageContent).toHaveBeenCalledTimes(1);
    expect(worker.runtimeStatus()).toMatchObject({
      enabled: true,
      retentionDays: 30,
      running: true,
      lastErrorAt: null,
    });

    release?.();
    await worker.stop();
    expect(worker.runtimeStatus()).toMatchObject({
      running: false,
      lastSuccessAt: null,
      lastRedactedCount: 0,
      batchLimitReached: false,
    });
    expect(worker.runtimeStatus().lastErrorAt).not.toBeNull();
  });
});
