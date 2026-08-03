import { describe, expect, it, vi } from "vitest";

import { FixedWindowRateLimiter } from "../modules/reliability/rate-limiter.js";
import { BoundedExecutionGate } from "../modules/workflow/execution-gate.js";

describe("reliability guards", () => {
  it("bounds fixed-window requests and resets after the window", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(2, 1_000, 10, () => now);

    expect(limiter.consume("client")).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(limiter.consume("client")).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.consume("client")).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });
    now += 1_000;
    expect(limiter.consume("client")).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });

  it("bounds concurrent workflow work and its waiting queue", async () => {
    const gate = new BoundedExecutionGate(1, 1, 1_000);
    let releaseFirst: (() => void) | undefined;
    const first = gate.run(
      () =>
        new Promise<string>((resolve) => {
          releaseFirst = () => resolve("first");
        }),
    );
    const second = gate.run(() => Promise.resolve("second"));

    expect(gate.status()).toMatchObject({ active: 1, queued: 1 });
    await expect(
      gate.run(() => Promise.resolve("overflow")),
    ).rejects.toMatchObject({
      code: "WORKFLOW_QUEUE_FULL",
    });
    releaseFirst?.();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(gate.status()).toMatchObject({ active: 0, queued: 0 });
  });

  it("removes queued work after its capacity wait expires", async () => {
    vi.useFakeTimers();
    try {
      const gate = new BoundedExecutionGate(1, 1, 50);
      let releaseActive: (() => void) | undefined;
      const active = gate.run(
        () =>
          new Promise<string>((resolve) => {
            releaseActive = () => resolve("active");
          }),
      );
      const waiting = gate.run(() => Promise.resolve("late"));
      const timedOut = expect(waiting).rejects.toMatchObject({
        code: "WORKFLOW_QUEUE_WAIT_TIMEOUT",
      });

      expect(gate.status()).toMatchObject({ active: 1, queued: 1 });
      await vi.advanceTimersByTimeAsync(50);
      await timedOut;
      expect(gate.status()).toMatchObject({ active: 1, queued: 0 });

      releaseActive?.();
      await expect(active).resolves.toBe("active");
      expect(gate.status()).toMatchObject({ active: 0, queued: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
