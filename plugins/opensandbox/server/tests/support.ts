import { vi } from "vitest";
import { SandboxPool } from "../src/lifecycle.js";
import type { Backend, Handle } from "../src/backend.js";
export function fixture(max = 1, ttl = 600000) {
  const live = new Map<string, string>();
  const run = vi.fn<Handle["run"]>().mockResolvedValue({
    status: "completed",
    exitCode: 0,
    stdout: "4",
    stderr: "",
    durationMs: 1,
    truncated: false,
  });
  const backend: Backend = {
    create: vi.fn((owner: string) => {
      const id = `sandbox-${live.size}`;
      live.set(id, owner);
      return Promise.resolve({ id, run, close: () => Promise.resolve() });
    }),
    owned: vi.fn((owner?: string) =>
      Promise.resolve(
        [...live]
          .filter(([, value]) => !owner || owner === value)
          .map(([id]) => id),
      ),
    ),
    remove: vi.fn((id: string) => {
      live.delete(id);
      return Promise.resolve(true);
    }),
    close: () => Promise.resolve(),
  };
  return { pool: new SandboxPool(backend, max, ttl), backend, live, run };
}
