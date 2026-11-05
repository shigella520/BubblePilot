import { TransferFailure } from "./attachment-contract.js";
import { workspaceUsageCommand } from "./attachment-helper.js";
import type { TransferInput, TransferResult } from "./attachment-contract.js";
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
  private sweeping: Promise<void> | undefined;
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
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.sweepSessions();
    try {
      await this.sweeping;
    } finally {
      this.sweeping = undefined;
    }
  }
  private async sweepSessions() {
    for (const session of this.sessions) {
      if (Date.now() >= session.expiresAt) session.invalidate();
      if (!session.ended) await session.checkSpace();
      if (session.ended && (await session.cleanup())) {
        this.occupied.delete(session);
        this.sessions.delete(session);
      }
    }
  }
}
export class SandboxSession {
  readonly owner = randomUUID();
  readonly expiresAt: number;
  readonly abort = new AbortController();
  ended = false;
  private busy = false;
  private imported = new Map<
    string,
    { input: string; result: TransferResult }
  >();
  private importBytes = 0;
  private expandedBytes = 0;
  private expandedFiles = 0;
  private importLimits?: TransferInput["limits"];
  importStatus(id: string, input?: TransferInput) {
    this.check();
    const existing = this.imported.get(id);
    if (existing && input && existing.input !== JSON.stringify(input))
      throw new ToolError("import_id_conflict");
    return existing?.result ?? null;
  }
  async importAttachment(
    input: TransferInput,
    body: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ) {
    this.check();
    signal.throwIfAborted();
    const previous = this.imported.get(input.id);
    if (previous) {
      if (previous.input !== JSON.stringify(input))
        throw new ToolError("import_id_conflict");
      return previous.result;
    }
    if (
      this.importLimits &&
      JSON.stringify(this.importLimits) !== JSON.stringify(input.limits)
    )
      throw new ToolError("import_limits_changed");
    this.importLimits ??= input.limits;
    if (
      this.imported.size >= input.limits.files ||
      this.importBytes + input.size > input.limits.totalMiB * 1024 * 1024
    )
      throw new ToolError("attachment_quota_exceeded");
    await this.prepare(signal);
    this.check();
    if (!this.handle?.upload)
      throw new ToolError("attachment_transfer_unsupported");
    this.busy = true;
    const combined = AbortSignal.any([
      signal,
      this.abort.signal,
      AbortSignal.timeout(45000),
    ]);
    const cancel = () => this.invalidate();
    combined.addEventListener("abort", cancel, { once: true });
    try {
      const result = {
        ...(await this.handle.upload(input, body, combined)),
        sandboxGeneration: this.owner,
        runtime: this.runtime,
      };
      combined.throwIfAborted();
      this.expandedBytes += result.expandedBytes;
      this.expandedFiles += result.expandedFiles;
      if (
        this.expandedBytes > input.limits.expandedMiB * 1024 * 1024 ||
        this.expandedFiles > input.limits.expandedFiles
      )
        throw new ToolError("archive_quota_exceeded");
      this.importBytes += input.size;
      this.imported.set(input.id, { input: JSON.stringify(input), result });
      return result;
    } catch (error) {
      this.invalidate();
      throw new ToolError(
        error instanceof TransferFailure
          ? `attachment_${error.reason}_session_invalidated`
          : "attachment_failed_session_invalidated_do_not_replay",
      );
    } finally {
      combined.removeEventListener("abort", cancel);
      this.busy = false;
    }
  }
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
  async checkSpace() {
    if (!this.importLimits || !this.handle || this.ended) return;
    try {
      const result = await this.handle.run(
        workspaceUsageCommand,
        AbortSignal.any([this.abort.signal, AbortSignal.timeout(2000)]),
        2,
      );
      const kib = Number(result.stdout.trim());
      if (
        result.status !== "completed" ||
        !result.stdout.trim() ||
        !Number.isFinite(kib) ||
        kib > 256 * 1024
      )
        this.invalidate();
    } catch {
      this.invalidate();
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
