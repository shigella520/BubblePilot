import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ToolError } from "./errors.js";
import {
  acceptedInputMimeTypes,
  inspectImage,
  validateExportPng,
  type InputMime,
} from "./images.js";

export const workspacePrefix = "/workspace/image-gen/";
export const attachmentProtocol = "io.bubblepilot/attachments";
export const imageExportProtocol = "io.bubblepilot/image-export";

/** Same rule as OpenSandbox's imageExportPath, narrowed to this plugin's prefix. */
export function validWorkspacePath(path: string) {
  return (
    path.length <= 4096 &&
    path.startsWith(workspacePrefix) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .slice(workspacePrefix.length)
      .split("/")
      .every((part) => part && part !== "." && part !== "..")
  );
}
export const workspacePath = z
  .string()
  .max(4096)
  .refine(
    validWorkspacePath,
    `A path below ${workspacePrefix} returned by this plugin is required`,
  );

/** Byte-identical to OpenSandbox attachment-contract.ts transferSchema. */
export const transferSchema = z
  .object({
    id: z.string().uuid(),
    filename: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^/\\]+$/u)
      .refine((v) =>
        [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
      )
      .refine((v) => v !== "." && v !== ".."),
    size: z
      .number()
      .int()
      .min(1)
      .max(20 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    limits: z
      .object({
        files: z.number().int().min(1).max(5),
        totalMiB: z.number().int().min(1).max(50),
        expandedMiB: z.number().int().min(1).max(100),
        expandedFiles: z.number().int().min(1).max(500),
      })
      .strict(),
  })
  .strict();
export type TransferInput = z.infer<typeof transferSchema>;
/** Same shape as OpenSandbox TransferResult; images are never expanded. */
export interface TransferResult {
  status: "imported";
  sandbox_path: string;
  size: number;
  sha256: string;
  expandedBytes: 0;
  expandedFiles: 0;
  mimeType: InputMime;
  width: number;
  height: number;
  sandboxGeneration: string;
}

interface StoredFile {
  data: Buffer;
  mime: InputMime;
  width: number;
  height: number;
  kind: "attachment" | "output";
}

export interface WorkspaceLimits {
  ttlMs: number;
  maxFiles: number;
  maxBytes: number;
  importTimeoutMs: number;
}

export class Workspace {
  readonly owner = randomUUID();
  readonly expiresAt: number;
  readonly abort = new AbortController();
  ended = false;
  generations = 0;
  private readonly files = new Map<string, StoredFile>();
  private readonly imported = new Map<
    string,
    { input: string; result: TransferResult }
  >();
  private importLimits?: TransferInput["limits"];
  private importBytes = 0;
  constructor(private readonly limits: WorkspaceLimits) {
    this.expiresAt = Date.now() + limits.ttlMs;
  }
  get importTimeoutMs() {
    return this.limits.importTimeoutMs;
  }
  get usedBytes() {
    let total = 0;
    for (const file of this.files.values()) total += file.data.length;
    return total;
  }
  invalidate() {
    this.ended = true;
    this.files.clear();
    this.imported.clear();
    this.abort.abort();
  }
  check() {
    if (Date.now() >= this.expiresAt) this.invalidate();
    if (this.ended) throw new ToolError("session_expired_or_invalidated");
  }
  private reserve(bytes: number) {
    if (
      this.files.size >= this.limits.maxFiles ||
      this.usedBytes + bytes > this.limits.maxBytes
    )
      throw new ToolError("workspace_full");
  }
  importStatus(id: string, input?: TransferInput) {
    this.check();
    const existing = this.imported.get(id);
    if (existing && input && existing.input !== JSON.stringify(input))
      throw new ToolError("import_id_conflict");
    return existing?.result ?? null;
  }
  /** Mirrors OpenSandbox SandboxSession.importAttachment error semantics. */
  async importAttachment(
    input: TransferInput,
    body: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<TransferResult> {
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
    this.reserve(input.size);
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of body) {
        signal.throwIfAborted();
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      // Same contract as OpenSandbox: a failed transfer invalidates the session
      // and must not be replayed by the caller.
      this.invalidate();
      throw new ToolError(
        error instanceof ToolError &&
          error.message === "attachment_hash_mismatch"
          ? "attachment_hash_mismatch_session_invalidated"
          : "attachment_failed_session_invalidated_do_not_replay",
      );
    }
    const data = Buffer.concat(chunks);
    let info;
    try {
      info = await inspectImage(data);
      if (info.animated) throw new ToolError("input_type_unsupported");
    } catch {
      // Content outside the declared mimeTypes is rejected without invalidation;
      // nothing was stored and the bytes matched the authorised hash.
      throw new ToolError("attachment_type_unsupported");
    }
    this.check();
    const path = `${workspacePrefix}attachments/${input.id}/${input.filename}`;
    this.files.set(path, { data, kind: "attachment", ...info });
    const result: TransferResult = {
      status: "imported",
      sandbox_path: path,
      size: input.size,
      sha256: input.sha256,
      expandedBytes: 0,
      expandedFiles: 0,
      mimeType: info.mime,
      width: info.width,
      height: info.height,
      sandboxGeneration: this.owner,
    };
    this.importBytes += input.size;
    this.imported.set(input.id, { input: JSON.stringify(input), result });
    return result;
  }
  read(path: string): StoredFile {
    this.check();
    if (!validWorkspacePath(path)) throw new ToolError("image_path_denied");
    const file = this.files.get(path);
    if (!file) throw new ToolError("image_not_found");
    return file;
  }
  storeOutput(png: Buffer, width: number, height: number) {
    this.check();
    this.reserve(png.length);
    const path = `${workspacePrefix}out/${randomUUID()}.png`;
    this.files.set(path, {
      data: png,
      mime: "image/png",
      width,
      height,
      kind: "output",
    });
    return path;
  }
  async exportImage(path: string, signal: AbortSignal) {
    this.check();
    if (!validWorkspacePath(path)) throw new ToolError("image_path_denied");
    const file = this.files.get(path);
    if (!file) throw new ToolError("image_not_found");
    signal.throwIfAborted();
    await validateExportPng(file.data);
    return file.data;
  }
}

export const declaredMimeTypes = [...acceptedInputMimeTypes];
