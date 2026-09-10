import { describe, expect, it } from "vitest";
import {
  estimateProgress,
  type ProgressSample,
} from "../modules/memory/job-progress.js";
const now = Date.parse("2026-09-10T12:00:00Z");
const samples: ProgressSample[] = [1, 2, 3].map((n) => ({
  at: now - (3 - n) * 5000,
  milliseconds: 5000,
  characters: 1000,
  messages: 10,
}));
describe("memory task ETA", () => {
  it("waits for three batches and 15 seconds; uses character throughput and rounded minutes", () => {
    expect(
      estimateProgress(samples.slice(0, 2), 12000, "running", now, true, now)
        .status,
    ).toBe("warming");
    expect(
      estimateProgress(
        samples.map((s) => ({ ...s, milliseconds: 1000 })),
        12000,
        "running",
        now,
        true,
        now,
      ).status,
    ).toBe("warming");
    expect(estimateProgress(samples, 12000, "queued", now, true, now)).toEqual({
      status: "available",
      messagesPerMinute: 120,
      remainingSeconds: 60,
      estimatedCompletionAt: "2026-09-10T12:01:00.000Z",
    });
  });
  it("suppresses estimates for interruption, waiting, and stalled progress", () => {
    for (const state of ["paused", "failed", "cancelled", "succeeded"])
      expect(estimateProgress(samples, 10, state, now, true, now).status).toBe(
        state,
      );
    expect(
      estimateProgress(samples, 10, "queued", now, false, now).status,
    ).toBe("waiting");
    expect(
      estimateProgress(samples, 10, "running", now - 60000, true, now).status,
    ).toBe("stalled");
    expect(estimateProgress([], 10, "running", now, true, now).status).toBe(
      "warming",
    );
  });
  it("uses only ten recent batches so load changes replace older speed", () => {
    const recent = Array.from({ length: 10 }, () => ({
      ...samples[0]!,
      milliseconds: 10000,
    }));
    const actual = estimateProgress(
      [...samples, ...recent],
      12000,
      "running",
      now,
      true,
      now,
    );
    expect(actual.remainingSeconds).toBe(120);
    expect(actual.messagesPerMinute).toBe(60);
  });
});
