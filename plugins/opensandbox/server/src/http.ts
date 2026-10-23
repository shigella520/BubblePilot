import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createServer, type IncomingMessage } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  type SandboxPool,
  ToolError,
  type SandboxSession,
} from "./lifecycle.js";
import { fileCommand } from "./files.js";

const path = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      value.startsWith("/workspace/") &&
      !value.includes("\0") &&
      !value
        .slice(11)
        .split("/")
        .some((part) => ["", ".", ".."].includes(part)),
    "An absolute file path below /workspace is required",
  );
function reply(data: Record<string, unknown>, isError = false) {
  return {
    isError,
    structuredContent: data,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}
function register(server: McpServer, session: SandboxSession) {
  const safe = async (action: () => Promise<Record<string, unknown>>) => {
    try {
      const value = await action();
      return reply(
        value,
        !["created", "reused", "completed", "read", "written"].includes(
          String(value.status),
        ),
      );
    } catch (error) {
      return reply(
        {
          status:
            error instanceof ToolError ? error.message : "operation_failed",
        },
        true,
      );
    }
  };
  server.registerTool(
    "prepare_sandbox",
    {
      description:
        "Create this run's temporary Python workspace. Call once before command/file tools; repeated calls reuse it. Busy means no capacity. Never assume files survive session expiry.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    (_, extra) => safe(() => session.prepare(extra.signal)),
  );
  server.registerTool(
    "run_command",
    {
      description:
        "Run a foreground shell command inside this run's sandbox. No host mounts. Nonzero exit is failure. Unknown/cancelled results must not be replayed. Output cap 1 MiB; redirect large output into /workspace files and read portions.",
      inputSchema: {
        command: z.string().min(1).max(32768),
        timeout_seconds: z.number().int().min(1).max(30).default(20),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    ({ command, timeout_seconds }, extra) =>
      safe(async () => ({
        ...(await session.run(
          `cd /workspace &&\n${command}`,
          timeout_seconds,
          extra.signal,
        )),
      })),
  );
  server.registerTool(
    "read_file",
    {
      description:
        "Read UTF-8 text below /workspace without following symlinks. offset and length are bytes; use returned nextOffset. Maximum 65536 bytes. Not a binary file tool.",
      inputSchema: {
        path,
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
        length: z.number().int().min(4).max(65536).default(16384),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    (args, extra) =>
      safe(async () => {
        const result = await session.run(
          fileCommand({ op: "read", ...args }),
          10,
          extra.signal,
        );
        if (result.status !== "completed") return { ...result };
        return z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(result.stdout));
      }),
  );
  server.registerTool(
    "write_file",
    {
      description:
        "Overwrite a UTF-8 regular file below /workspace, without following symlinks. Parent directories must exist. At most 65536 UTF-8 bytes. Does not write host files.",
      inputSchema: {
        path,
        text: z
          .string()
          .max(65536)
          .refine((value) => Buffer.byteLength(value) <= 65536),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    (args, extra) =>
      safe(async () => {
        const result = await session.run(
          fileCommand({ op: "write", ...args }),
          10,
          extra.signal,
        );
        if (result.status !== "completed") return { ...result };
        return z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(result.stdout));
      }),
  );
}
async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    size += chunk.length;
    if (size > 512 * 1024) throw new Error("Body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export function createMcpHttp(
  pool: SandboxPool,
  token: string,
  maxSessions = 64,
) {
  const sessions = new Map<
    string,
    {
      server: McpServer;
      transport: StreamableHTTPServerTransport;
      sandbox: SandboxSession;
    }
  >();
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const http = createServer((req, res) => {
    void (async () => {
      if (req.url !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      const auth = createHash("sha256")
        .update(req.headers.authorization ?? "")
        .digest();
      if (!timingSafeEqual(expected, auth)) {
        res.writeHead(401).end();
        return;
      }
      // This is a server-to-server endpoint, not a browser application.
      if (req.headers.origin) {
        res.writeHead(403).end();
        return;
      }
      if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) {
        res.writeHead(405).end();
        return;
      }
      const id = req.headers["mcp-session-id"];
      let pair = typeof id === "string" ? sessions.get(id) : undefined;
      if (id && (!pair || pair.sandbox.ended)) {
        res.writeHead(404).end();
        return;
      }
      const parsed = req.method === "POST" ? await body(req) : undefined;
      if (!pair) {
        if (req.method !== "POST" || !isInitializeRequest(parsed)) {
          res.writeHead(400).end();
          return;
        }
        if (pool.sessions.size >= maxSessions) {
          res.writeHead(503).end();
          return;
        }
        const sandbox = pool.newSession();
        const server = new McpServer({
          name: "bubblepilot-opensandbox",
          version: "0.1.0",
        });
        register(server, sandbox);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, { server, transport, sandbox });
          },
        });
        await server.connect(transport as Transport);
        pair = { server, transport, sandbox };
      }
      if (req.method === "DELETE") {
        pair.sandbox.invalidate();
        if (typeof id === "string") sessions.delete(id);
      }
      await pair.transport.handleRequest(req, res, parsed);
      if (req.method === "DELETE")
        void pair.server.close().catch(() => undefined);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
  });
  http.requestTimeout = 15000;
  http.headersTimeout = 10000;
  const timer = setInterval(() => {
    for (const [id, pair] of sessions)
      if (pair.sandbox.ended || Date.now() >= pair.sandbox.expiresAt) {
        pair.sandbox.invalidate();
        sessions.delete(id);
        void pair.server.close().catch(() => undefined);
      }
    void pool.sweep().catch(() => undefined);
  }, 1000);
  timer.unref();
  return {
    http,
    async close() {
      clearInterval(timer);
      for (const pair of sessions.values()) {
        pair.sandbox.invalidate();
        void pair.server.close().catch(() => undefined);
      }
      sessions.clear();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await pool.sweep();
    },
  };
}
