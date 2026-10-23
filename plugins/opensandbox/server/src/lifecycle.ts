import {
  initializeWorkspaceCommand,
  parseRuntime,
  type RuntimeInfo,
} from "./runtime.js";
import { randomUUID } from "node:crypto";
import type { Backend, Handle } from "./backend.js";

export class ToolError extends Error {}
export class SandboxPool {
  readonly sessions = new Set<SandboxSession>();
  private readonly occupied = new Set<SandboxSession>();
  private sweeping = false;
  constructor(
    readonly backend: Backend,
    readonly maximum: number,
    readonly ttlMs: number,
  ) {}
  newSession() {
    const session = new SandboxSession(this);
    this.sessions.add(session);
    return session;
  }
  claim(session: SandboxSession) {
    if (this.occupied.size >= this.maximum)
      throw new ToolError("capacity_busy");
    this.occupied.add(session);
  }
  get used() {
    return this.occupied.size;
  }
  async reconcile() {
    const ids = await this.backend.owned();
    for (const id of ids)
      if (!(await this.backend.remove(id)))
        throw new Error("Orphan cleanup incomplete");
  }
  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const session of this.sessions) {
        if (Date.now() >= session.expiresAt) session.invalidate();
        if (session.ended && (await session.cleanup())) {
          this.occupied.delete(session);
          this.sessions.delete(session);
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
}
export class SandboxSession {
  readonly owner = randomUUID();
  readonly expiresAt: number;
  readonly abort = new AbortController();
  ended = false;
  private busy = false;
  private handle: Handle | undefined;
  private runtime: RuntimeInfo = { id: "unknown" };
  private creating = false;
  private claimed = false;
  private uncertainUntil = 0;
  constructor(private readonly pool: SandboxPool) {
    this.expiresAt = Date.now() + pool.ttlMs;
  }
  invalidate() {
    this.ended = true;
    this.abort.abort();
  }
  private check() {
    if (Date.now() >= this.expiresAt) this.invalidate();
    if (this.ended) throw new ToolError("session_expired_or_invalidated");
    if (this.busy) throw new ToolError("sandbox_busy");
  }
  async prepare(signal: AbortSignal) {
    this.check();
    signal.throwIfAborted();
    if (this.handle)
      return {
        status: "reused",
        workspace: "/workspace",
        expiresAt: this.expiresAt,
        runtime: this.runtime,
      };
    this.pool.claim(this);
    this.claimed = true;
    this.busy = this.creating = true;
    const combined = AbortSignal.any([
      signal,
      this.abort.signal,
      AbortSignal.timeout(40000),
    ]);
    const cancel = () => this.invalidate();
    combined.addEventListener("abort", cancel, { once: true });
    try {
      this.handle = await this.pool.backend.create(this.owner, combined);
      combined.throwIfAborted();
      const initialized = await this.handle.run(
        initializeWorkspaceCommand,
        combined,
        5,
      );
      combined.throwIfAborted();
      if (initialized.status !== "completed")
        throw new Error("Workspace unavailable");
      this.runtime = parseRuntime(initialized.stdout);
      return {
        status: "created",
        workspace: "/workspace",
        expiresAt: this.expiresAt,
        runtime: this.runtime,
      };
    } catch {
      // A create may have reached the server without returning its ID. Keep the slot
      // through the absolute remote TTL and reconcile by our unique ownership label.
      this.uncertainUntil = this.handle ? 0 : Date.now() + this.pool.ttlMs;
      this.invalidate();
      throw new ToolError("prepare_failed_session_invalidated");
    } finally {
      combined.removeEventListener("abort", cancel);
      this.busy = this.creating = false;
    }
  }
  async run(command: string, seconds: number, signal: AbortSignal) {
    this.check();
    signal.throwIfAborted();
    if (!this.handle) throw new ToolError("prepare_sandbox_required");
    this.busy = true;
    const combined = AbortSignal.any([
      signal,
      this.abort.signal,
      AbortSignal.timeout(seconds * 1000),
    ]);
    const cancel = () => this.invalidate();
    combined.addEventListener("abort", cancel, { once: true });
    try {
      const result = await this.handle.run(command, combined, seconds);
      combined.throwIfAborted();
      if (result.truncated || result.status === "result_unknown")
        this.invalidate();
      return result;
    } catch {
      this.invalidate();
      throw new ToolError(
        "command_result_unknown_session_invalidated_do_not_replay",
      );
    } finally {
      combined.removeEventListener("abort", cancel);
      this.busy = false;
    }
  }
  async cleanup() {
    if (this.creating) return false;
    if (!this.claimed) return true;
    try {
      const ids = new Set(await this.pool.backend.owned(this.owner));
      if (this.handle) ids.add(this.handle.id);
      for (const id of ids)
        if (!(await this.pool.backend.remove(id))) return false;
      await this.handle?.close();
      this.handle = undefined;
      return Date.now() >= this.uncertainUntil;
    } catch {
      return false;
    }
  }
}
