import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { imageExportErrors, ToolError } from "./errors.js";
import {
  transferSchema,
  workspacePath,
  type TransferInput,
  type Workspace,
} from "./workspace.js";

const maxTickets = 4;
const exportTicketMs = 30_000;

async function readSmallJson(req: IncomingMessage, onTooLarge: string) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk as Uint8Array);
    size += data.length;
    if (size > 8192) throw new ToolError(onTooLarge);
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function guard(
  req: IncomingMessage,
  res: ServerResponse,
  ws: Workspace,
  ms: number,
) {
  const abort = new AbortController();
  const cancel = () => {
    if (!res.writableFinished) abort.abort();
  };
  req.once("aborted", cancel);
  res.once("close", cancel);
  const signal = AbortSignal.any([
    abort.signal,
    ws.abort.signal,
    AbortSignal.timeout(ms),
  ]);
  const abortBody = () => {
    if (!req.complete) req.destroy();
  };
  signal.addEventListener("abort", abortBody, { once: true });
  return {
    signal,
    release: () => {
      signal.removeEventListener("abort", abortBody);
      req.removeListener("aborted", cancel);
      res.removeListener("close", cancel);
    },
  };
}

/** Mirrors OpenSandbox attachment-http.ts (tickets, single use, hash checks). */
export class AttachmentTransfers {
  private tickets = new Map<
    string,
    { input: TransferInput; expires: number }
  >();
  constructor(private readonly ws: Workspace) {}
  async handle(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, value: unknown) => {
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    };
    if (req.method !== "POST") {
      send(405, { error: "method_not_allowed" });
      return;
    }
    const { signal, release } = guard(
      req,
      res,
      this.ws,
      this.ws.importTimeoutMs,
    );
    try {
      for (const [key, ticket] of this.tickets)
        if (ticket.expires < Date.now()) this.tickets.delete(key);
      if (req.url === "/mcp/attachments/tickets") {
        const input = transferSchema.parse(
          await readSmallJson(req, "invalid_transfer_metadata"),
        );
        signal.throwIfAborted();
        const existing = this.ws.importStatus(input.id, input);
        if (existing) {
          send(200, { result: existing });
          return;
        }
        if (this.tickets.size >= maxTickets)
          throw new ToolError("transfer_capacity_busy");
        const token = randomBytes(32).toString("hex");
        this.tickets.set(token, {
          input,
          expires: Date.now() + this.ws.importTimeoutMs,
        });
        send(200, {
          token,
          expiresInSeconds: this.ws.importTimeoutMs / 1000,
        });
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
      if (
        Number(req.headers["content-length"]) !== ticket.input.size ||
        req.headers["transfer-encoding"]
      )
        throw new ToolError("invalid_transfer_length");
      const hash = createHash("sha256");
      async function* source() {
        let bytes = 0;
        for await (const chunk of req) {
          signal.throwIfAborted();
          const data = Buffer.from(chunk as Uint8Array);
          bytes += data.length;
          if (bytes > ticket!.input.size)
            throw new ToolError("attachment_too_large");
          hash.update(data);
          yield data;
        }
        if (
          bytes !== ticket!.input.size ||
          hash.digest("hex") !== ticket!.input.sha256
        )
          throw new ToolError("attachment_hash_mismatch");
      }
      const result = await this.ws.importAttachment(
        ticket.input,
        source(),
        signal,
      );
      signal.throwIfAborted();
      send(200, { result });
    } catch (error) {
      send(422, {
        error:
          error instanceof ToolError
            ? error.message
            : "attachment_transfer_failed",
      });
    } finally {
      release();
    }
  }
}

/** Mirrors OpenSandbox image-export-http.ts (PNG only; no file-export in v1). */
export class ImageExports {
  private readonly tickets = new Map<
    string,
    { path: string; expires: number }
  >();
  constructor(private readonly ws: Workspace) {}
  async handle(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, error: unknown) =>
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(error));
    if (req.method !== "POST") {
      send(405, { error: "method_not_allowed" });
      return;
    }
    const { signal, release } = guard(req, res, this.ws, exportTicketMs);
    try {
      for (const [key, value] of this.tickets)
        if (value.expires <= Date.now()) this.tickets.delete(key);
      if (req.url?.endsWith("/tickets")) {
        const parsed = z
          .object({ path: z.string().max(4096) })
          .strict()
          .parse(await readSmallJson(req, "image_path_denied"));
        if (!workspacePath.safeParse(parsed.path).success)
          throw new ToolError("image_path_denied");
        signal.throwIfAborted();
        if (this.tickets.size >= maxTickets)
          throw new ToolError("sandbox_busy");
        const token = randomBytes(32).toString("hex");
        this.tickets.set(token, {
          path: parsed.path,
          expires: Date.now() + exportTicketMs,
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
      const data = await this.ws.exportImage(ticket.path, signal);
      signal.throwIfAborted();
      res
        .writeHead(200, {
          "content-type": "image/png",
          "content-length": data.length,
          "x-content-sha256": createHash("sha256").update(data).digest("hex"),
          "cache-control": "no-store",
        })
        .end(data);
    } catch (error) {
      send(422, {
        error:
          error instanceof ToolError && imageExportErrors.has(error.message)
            ? error.message
            : "image_export_failed",
      });
    } finally {
      release();
    }
  }
}
