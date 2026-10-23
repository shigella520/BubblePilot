import { expect, it, vi } from "vitest";
import { fixture } from "./support.js";
import type { Handle } from "../src/backend.js";
const signal = () => new AbortController().signal;
it("creates lazily, isolates runs, reuses once, and counts cleaning slots", async () => {
  const { pool, backend } = fixture();
  const a = pool.newSession(),
    b = pool.newSession();
  expect(backend.create).not.toHaveBeenCalled();
  await expect(a.run("echo hi", 1, signal())).rejects.toThrow(
    "prepare_sandbox_required",
  );
  await expect(a.prepare(signal())).resolves.toMatchObject({
    status: "created",
  });
  await expect(a.prepare(signal())).resolves.toMatchObject({
    status: "reused",
  });
  await expect(b.prepare(signal())).rejects.toThrow("capacity_busy");
  a.invalidate();
  await expect(b.prepare(signal())).rejects.toThrow("capacity_busy");
  await pool.sweep();
  await b.prepare(signal());
  expect(backend.create).toHaveBeenCalledTimes(2);
});
it("cleans a late accepted sandbox before releasing its slot", async () => {
  const { pool, backend } = fixture();
  let finish!: (handle: Handle) => void;
  vi.mocked(backend.create).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const a = pool.newSession();
  const pending = a.prepare(signal());
  a.invalidate();
  finish({ id: "late", run: vi.fn(), close: () => Promise.resolve() });
  await expect(pending).rejects.toThrow("prepare_failed");
  await pool.sweep();
  expect(backend.remove).toHaveBeenCalledWith("late");
  expect(pool.used).toBe(0);
});
it("invalidates on cancellation and never replays an uncertain command", async () => {
  const { pool, run } = fixture();
  const a = pool.newSession();
  await a.prepare(signal());
  run.mockImplementation(async (_, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return {
      status: "completed",
      exitCode: 0,
      stdout: "late",
      stderr: "",
      durationMs: 1,
      truncated: false,
    };
  });
  const controller = new AbortController();
  const pending = a.run("side effect", 20, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("result_unknown");
  await expect(a.prepare(signal())).rejects.toThrow("invalidated");
  expect(run).toHaveBeenCalledTimes(2);
});
it("rejects concurrent commands and retains cleanup failures", async () => {
  const { pool, backend, run } = fixture();
  const a = pool.newSession();
  await a.prepare(signal());
  let finish!: () => void;
  run.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            status: "completed",
            exitCode: 0,
            stdout: "",
            stderr: "",
            durationMs: 1,
            truncated: false,
          });
      }),
  );
  const pending = a.run("slow", 20, signal());
  await expect(a.run("other", 20, signal())).rejects.toThrow("sandbox_busy");
  finish();
  await pending;
  a.invalidate();
  vi.mocked(backend.remove).mockResolvedValue(false);
  await pool.sweep();
  expect(pool.used).toBe(1);
});
it("expires absolutely and startup reconciliation fails closed", async () => {
  const { pool, backend } = fixture(1, 10);
  const a = pool.newSession();
  await a.prepare(signal());
  vi.spyOn(Date, "now").mockReturnValue(a.expiresAt + 1);
  try {
    await pool.sweep();
    await expect(a.prepare(signal())).rejects.toThrow("expired");
  } finally {
    vi.restoreAllMocks();
  }
  vi.mocked(backend.owned).mockResolvedValue(["own-orphan"]);
  vi.mocked(backend.remove).mockResolvedValue(false);
  await expect(pool.reconcile()).rejects.toThrow("Orphan cleanup");
});

it("retains admission after losing the create response until TTL", async () => {
  const { pool, backend } = fixture();
  vi.mocked(backend.create).mockRejectedValue(new Error("lost response"));
  const session = pool.newSession();
  await expect(session.prepare(signal())).rejects.toThrow("prepare_failed");
  await pool.sweep();
  expect(pool.used).toBe(1);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 700000);
  try {
    await pool.sweep();
    expect(pool.used).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
});
