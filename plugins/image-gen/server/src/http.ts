import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { exportLimits } from "./images.js";
import { registerTools, type ToolDeps } from "./tools.js";
import { AttachmentTransfers, ImageExports } from "./transfers.js";
import {
  attachmentProtocol,
  declaredMimeTypes,
  imageExportProtocol,
  workspacePrefix,
  Workspace,
  type WorkspaceLimits,
} from "./workspace.js";

export const serverVersion = "0.1.0";
export const anchorTool = "generate_image";

/** Capabilities BP reads to treat this plugin as an image generator target. */
export function capabilities() {
  return {
    [imageExportProtocol]: {
      version: 1,
      fileBytes: exportLimits.bytes,
      anchorTool,
      workspacePrefix,
    },
    [attachmentProtocol]: {
      version: 1,
      fileBytes: 20 * 1024 * 1024,
      files: 5,
      totalBytes: 50 * 1024 * 1024,
      anchorTool,
      workspacePrefix,
      mimeTypes: declaredMimeTypes,
    },
  };
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

interface Pair {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  ws: Workspace;
  attachments: AttachmentTransfers;
  images: ImageExports;
  responses: Set<ServerResponse>;
}

export function createMcpHttp(
  deps: ToolDeps,
  token: string,
  limits: WorkspaceLimits,
  maxSessions = 8,
) {
  const sessions = new Map<string, Pair>();
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const http = createServer((req, res) => {
    void (async () => {
      const attachmentRoute = [
        "/mcp/attachments",
        "/mcp/attachments/tickets",
      ].includes(req.url ?? "");
      const imageRoute = [
        "/mcp/image-exports",
        "/mcp/image-exports/tickets",
      ].includes(req.url ?? "");
      if (req.url !== "/mcp" && !attachmentRoute && !imageRoute) {
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
      // Server-to-server endpoint, not a browser application.
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
      if (id && (!pair || pair.ws.ended)) {
        res.writeHead(404).end();
        return;
      }
      if (attachmentRoute || imageRoute) {
        if (!pair) {
          res.writeHead(403).end();
          return;
        }
        await (imageRoute ? pair.images : pair.attachments).handle(req, res);
        return;
      }
      const parsed = req.method === "POST" ? await body(req) : undefined;
      if (!pair) {
        if (req.method !== "POST" || !isInitializeRequest(parsed)) {
          res.writeHead(400).end();
          return;
        }
        if (sessions.size >= maxSessions) {
          res.writeHead(503).end();
          return;
        }
        const ws = new Workspace(limits);
        const server = new McpServer(
          { name: "bubblepilot-image-gen", version: serverVersion },
          { capabilities: { experimental: capabilities() } },
        );
        registerTools(server, ws, deps);
        const attachments = new AttachmentTransfers(ws);
        const images = new ImageExports(ws);
        const responses = new Set<ServerResponse>();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, {
              server,
              transport,
              ws,
              attachments,
              images,
              responses,
            });
          },
        });
        await server.connect(transport as Transport);
        pair = { server, transport, ws, attachments, images, responses };
      }
      if (req.method === "DELETE") {
        pair.ws.invalidate();
        if (typeof id === "string") sessions.delete(id);
      }
      if (req.method === "POST") {
        const responses = pair.responses;
        responses.add(res);
        const finished = () => {
          responses.delete(res);
        };
        res.once("finish", finished);
        res.once("close", finished);
      }
      await pair.transport.handleRequest(req, res, parsed);
      if (req.method === "DELETE")
        void pair.server.close().catch(() => undefined);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
  });
  http.requestTimeout = Math.max(45000, limits.importTimeoutMs);
  http.headersTimeout = 10000;
  const timer = setInterval(() => {
    for (const [id, pair] of sessions)
      if (pair.ws.ended || Date.now() >= pair.ws.expiresAt) {
        pair.ws.invalidate();
        if (pair.responses.size === 0) {
          sessions.delete(id);
          void pair.server.close().catch(() => undefined);
        }
      }
  }, 1000);
  timer.unref();
  return {
    http,
    sessions,
    async close() {
      clearInterval(timer);
      for (const pair of sessions.values()) {
        pair.ws.invalidate();
        void pair.server.close().catch(() => undefined);
      }
      sessions.clear();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
