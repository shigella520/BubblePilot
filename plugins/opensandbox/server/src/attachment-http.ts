import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { transferSchema, type TransferInput } from "./attachment-contract.js";
import { type SandboxSession, ToolError } from "./lifecycle.js";
export class AttachmentTransfers {
  private tickets = new Map<
    string,
    { input: TransferInput; expires: number }
  >();
  constructor(private readonly session: SandboxSession) {}
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
    const abort = new AbortController();
    const cancel = () => {
      if (!res.writableFinished) abort.abort();
    };
    req.once("aborted", cancel);
    res.once("close", cancel);
    const signal = AbortSignal.any([
      abort.signal,
      this.session.abort.signal,
      AbortSignal.timeout(this.session.importTimeoutMs),
    ]);
    const abortBody = () => req.destroy();
    signal.addEventListener("abort", abortBody, { once: true });
    try {
      for (const [key, ticket] of this.tickets)
        if (ticket.expires < Date.now()) this.tickets.delete(key);
      if (req.url === "/mcp/attachments/tickets") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const data = Buffer.from(chunk as Uint8Array);
          size += data.length;
          if (size > 8192) throw new ToolError("invalid_transfer_metadata");
          chunks.push(data);
        }
        const input = transferSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        signal.throwIfAborted();
        const existing = this.session.importStatus(input.id, input);
        if (existing) {
          send(200, { result: existing });
          return;
        }
        if (this.tickets.size >= 4)
          throw new ToolError("transfer_capacity_busy");
        const token = randomBytes(32).toString("hex");
        this.tickets.set(token, {
          input,
          expires: Date.now() + this.session.importTimeoutMs,
        });
        send(200, {
          token,
          expiresInSeconds: this.session.importTimeoutMs / 1000,
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
      const result = await this.session.importAttachment(
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
      signal.removeEventListener("abort", abortBody);
      req.removeListener("aborted", cancel);
      res.removeListener("close", cancel);
    }
  }
}
