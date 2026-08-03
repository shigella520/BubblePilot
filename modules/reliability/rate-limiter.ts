export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface WindowState {
  startedAt: number;
  count: number;
  lastSeenAt: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly maximumKeys = 10_000,
    private readonly now: () => number = Date.now,
  ) {
    if (maximum < 1 || windowMs < 1 || maximumKeys < 1) {
      throw new Error("Rate limiter bounds are invalid.");
    }
  }

  consume(key: string): RateLimitDecision {
    const now = this.now();
    let state = this.windows.get(key);
    if (state === undefined || state.startedAt + this.windowMs <= now) {
      this.makeCapacity(now);
      state = { startedAt: now, count: 0, lastSeenAt: now };
      this.windows.set(key, state);
    }
    state.lastSeenAt = now;
    if (state.count >= this.maximum) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((state.startedAt + this.windowMs - now) / 1_000),
        ),
      };
    }
    state.count += 1;
    return {
      allowed: true,
      remaining: this.maximum - state.count,
      retryAfterSeconds: 0,
    };
  }

  private makeCapacity(now: number): void {
    if (this.windows.size < this.maximumKeys) return;
    for (const [key, state] of this.windows) {
      if (state.startedAt + this.windowMs <= now) this.windows.delete(key);
    }
    if (this.windows.size < this.maximumKeys) return;
    const oldest = [...this.windows.entries()].sort(
      (left, right) => left[1].lastSeenAt - right[1].lastSeenAt,
    )[0];
    if (oldest !== undefined) this.windows.delete(oldest[0]);
  }
}
