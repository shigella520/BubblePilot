import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { imageExportErrors, imageExportPath } from "./image-export.js";
import { ToolError, type SandboxSession } from "./lifecycle.js";
export class ImageExports {
  private readonly tickets = new Map<
    string,
    { path: string; expires: number }
  >();
  constructor(
    private readonly session: SandboxSession,
    private readonly file = false,
  ) {}
  async handle(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, error: unknown) =>
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(error));
    if (req.method !== "POST") {
      send(405, { error: "method_not_allowed" });
      return;
    }
    const abort = new AbortController();
    const cancel = () => {
      if (!res.writableFinished) abort.abort();
    };
    req.once("aborted", cancel);
    res.once("close", cancel);
    const signal = AbortSignal.any([
      abort.signal,
      this.session.abort.signal,
      AbortSignal.timeout(30_000),
    ]);
    const abortBody = () => {
      if (!req.complete) req.destroy();
    };
    signal.addEventListener("abort", abortBody, { once: true });
    try {
      for (const [key, value] of this.tickets)
        if (value.expires <= Date.now()) this.tickets.delete(key);
      if (req.url?.endsWith("/tickets")) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const data = Buffer.from(chunk as Uint8Array);
          size += data.length;
          if (size > 8192) throw new ToolError("image_path_denied");
          chunks.push(data);
        }
        const input = z
          .object({ path: imageExportPath })
          .strict()
          .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        signal.throwIfAborted();
        if (this.tickets.size >= 4) throw new ToolError("sandbox_busy");
        const token = randomBytes(32).toString("hex");
        this.tickets.set(token, {
          path: input.path,
          expires: Date.now() + 30_000,
        });
        send(200, { token });
        return;
      }
      const token = req.headers["x-bp-transfer-token"];
      const ticket =
        typeof token === "string" ? this.tickets.get(token) : undefined;
      if (!ticket || typeof token !== "string") {
        send(403, { error: "transfer_denied" });
        return;
      }
      this.tickets.delete(token);
      const data = await this.session.exportImage(
        ticket.path,
        signal,
        this.file,
      );
      signal.throwIfAborted();
      res
        .writeHead(200, {
          "content-type": this.file ? "application/octet-stream" : "image/png",
          "content-length": data.length,
          "x-content-sha256": createHash("sha256").update(data).digest("hex"),
          "cache-control": "no-store",
        })
        .end(data);
    } catch (error) {
      send(422, {
        error:
          error instanceof ToolError &&
          (imageExportErrors.has(error.message) ||
            error.message === "sandbox_busy")
            ? error.message
            : "image_export_failed",
      });
    } finally {
      signal.removeEventListener("abort", abortBody);
      req.removeListener("aborted", cancel);
      res.removeListener("close", cancel);
    }
  }
}
