import { afterEach, expect, it, vi } from "vitest";
import { ProgressPoller } from "../apps/web/src/services/progress-poller.js";
afterEach(() => vi.useRealTimers());
it("polls every five seconds only while eligible and never overlaps", async () => {
  vi.useFakeTimers();
  let enabled = true;
  let resolve!: (value: number) => void;
  const load = vi.fn(
    () =>
      new Promise<number>((r) => {
        resolve = r;
      }),
  );
  const apply = vi.fn(),
    failed = vi.fn();
  const poller = new ProgressPoller({
    enabled: () => enabled,
    load,
    apply,
    failed,
  });
  poller.start();
  await vi.advanceTimersByTimeAsync(15000);
  expect(load).toHaveBeenCalledTimes(1);
  resolve(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(apply).toHaveBeenCalledWith(1);
  enabled = false;
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).toHaveBeenCalledTimes(1);
  enabled = true;
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).toHaveBeenCalledTimes(2);
  poller.stop();
  resolve(2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(apply).toHaveBeenCalledTimes(1);
});
it("discards responses after chat changes/actions and recovers from network failures", async () => {
  let resolve!: (value: number) => void;
  const load = vi.fn(
    () =>
      new Promise<number>((r) => {
        resolve = r;
      }),
  );
  const apply = vi.fn(),
    failed = vi.fn();
  const poller = new ProgressPoller({
    enabled: () => true,
    load,
    apply,
    failed,
  });
  const first = poller.tick();
  poller.invalidate();
  resolve(1);
  await first;
  expect(apply).not.toHaveBeenCalled();
  load.mockRejectedValueOnce(new Error("offline"));
  await poller.tick();
  expect(failed).toHaveBeenCalledTimes(1);
  load.mockResolvedValueOnce(3);
  await poller.tick();
  expect(apply).toHaveBeenCalledWith(3);
  poller.stop();
});
