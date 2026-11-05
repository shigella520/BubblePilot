import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  lstat,
  realpath,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { AttachmentError } from "./attachment-policy.js";
/** Reservations precede I/O and remain held until deletion; no byte buffers accumulate. */
export class AttachmentStore {
  private reserved = 0;
  constructor(
    readonly root: string,
    readonly maximumBytes = 256 * 1024 * 1024,
  ) {}
  async init(forbiddenRoots: string[] = []) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = await realpath(this.root);
    const forbidden = await Promise.all(
      forbiddenRoots.map(
        async (root) => await realpath(root).catch(() => resolve(root)),
      ),
    );
    if (
      forbidden.some(
        (root) =>
          target === resolve(root) || target.startsWith(resolve(root) + "/"),
      )
    )
      throw new Error(
        "Attachment temporary directory must be outside persistent and public data",
      );
    const info = await lstat(this.root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Attachment temporary directory must be private");
    // Prior process transfers cannot be resumed. Only our old random directories
    // are eligible; never follow links or touch unrelated temporary files.
    for (const name of await readdir(this.root)) {
      if (!/^transfer-[a-zA-Z0-9_-]+$/u.test(name)) continue;
      const path = join(this.root, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      const remaining = 3600_000 - (Date.now() - stat.mtimeMs);
      if (remaining <= 0) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      // Account for crash leftovers until the grace period expires. Temporary
      // storage is private to this application process, never shared by replicas.
      let bytes = 0;
      for (const file of await readdir(path)) {
        const entry = await lstat(join(path, file));
        if (entry.isFile()) bytes += entry.size;
      }
      this.reserved += bytes;
      const timer = setTimeout(() => {
        void rm(path, { recursive: true, force: true }).then(
          () => {
            this.reserved -= bytes;
          },
          () => undefined,
        );
      }, remaining);
      timer.unref();
    }
  }
  async stage(response: Response, maximum: number, signal: AbortSignal) {
    if (this.reserved + maximum > this.maximumBytes) {
      await response.body?.cancel();
      throw new AttachmentError("ATTACHMENT_CAPACITY_BUSY");
    }
    this.reserved += maximum;
    let directory: string | undefined;
    let released = false;
    const dispose = async () => {
      if (released) return;
      if (directory) await rm(directory, { recursive: true, force: true });
      released = true;
      this.reserved -= maximum;
    };
    try {
      signal.throwIfAborted();
      const declared = Number(response.headers.get("content-length"));
      if (declared > maximum) throw new AttachmentError("ATTACHMENT_TOO_LARGE");
      directory = await mkdtemp(join(resolve(this.root), "transfer-"));
      const file = join(directory, randomUUID());
      const fd = await open(file, "wx", 0o600);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      const hash = createHash("sha256");
      let size = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > maximum) throw new AttachmentError("ATTACHMENT_TOO_LARGE");
          hash.update(item.value);
          let offset = 0;
          while (offset < item.value.byteLength)
            offset += (
              await fd.write(item.value, offset, item.value.byteLength - offset)
            ).bytesWritten;
        }
        signal.throwIfAborted();
        if (!size) throw new AttachmentError("ATTACHMENT_EMPTY");
        if (declared > 0 && declared !== size)
          throw new AttachmentError("ATTACHMENT_LENGTH_MISMATCH");
        return { file, size, sha256: hash.digest("hex"), dispose };
      } finally {
        signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => undefined);
        await fd.close();
      }
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      await dispose();
      throw error;
    }
  }
}
