import { expect, it, vi } from "vitest";
import { boundedClose } from "../modules/plugins/bounded-close.js";
it("bounds cleanup and isolates synchronous and asynchronous failures", async () => {
  vi.useFakeTimers();
  try {
    const done = vi.fn();
    const pending = boundedClose(() => new Promise(() => undefined), 20).then(
      done,
    );
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(done).toHaveBeenCalledOnce();
    await expect(
      boundedClose(() => {
        throw new Error("unavailable");
      }),
    ).resolves.toBeUndefined();
    await expect(
      boundedClose(() => Promise.reject(new Error("unavailable"))),
    ).resolves.toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
