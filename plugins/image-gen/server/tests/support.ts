import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpHttp } from "../src/http.js";
import { DailyQuota } from "../src/quota.js";
import type { Logger } from "../src/tools.js";
import type { ImagesClient } from "../src/upstream.js";

export const token = "fictional-image-gen-token-0123456789";

export function solid(
  format: "png" | "jpeg" | "webp",
  width = 64,
  height = 48,
  color = "#3366cc",
) {
  const image = sharp({
    create: { width, height, channels: 3, background: color },
  });
  return (
    format === "png"
      ? image.png()
      : format === "jpeg"
        ? image.jpeg()
        : image.webp()
  ).toBuffer();
}

export const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

export async function quotaFile() {
  return join(await mkdtemp(join(tmpdir(), "image-gen-quota-")), "quota.json");
}

export interface Harness {
  url: URL;
  logs: Record<string, unknown>[];
  calls: { op: "generate" | "edit"; input: unknown }[];
  client: ImagesClient;
  connect(): Promise<{
    client: Client;
    transport: StreamableHTTPClientTransport;
  }>;
  post(
    path: string,
    session: string,
    init: { body?: RequestInit["body"]; headers?: Record<string, string> },
  ): Promise<Response>;
  close(): Promise<void>;
  service: ReturnType<typeof createMcpHttp>;
}

export async function harness(
  options: {
    dailyLimit?: number;
    sessionLimit?: number;
    client?: ImagesClient;
    ttlMs?: number;
  } = {},
): Promise<Harness> {
  const logs: Record<string, unknown>[] = [];
  const calls: Harness["calls"] = [];
  const client: ImagesClient = options.client ?? {
    generate: async (input) => {
      calls.push({ op: "generate", input });
      return {
        data: await solid("png", 96, 64, "#ff0000"),
        usage: { inputTokens: 5, outputTokens: 7 },
      };
    },
    edit: async (input) => {
      calls.push({ op: "edit", input });
      return {
        data: await solid("png", 64, 64, "#00ff00"),
        usage: { inputTokens: 9, outputTokens: 7 },
      };
    },
  };
  const log: Logger = (event) => logs.push(event);
  const service = createMcpHttp(
    {
      client,
      quota: new DailyQuota(
        await quotaFile(),
        options.dailyLimit ?? 20,
        "Asia/Shanghai",
      ),
      config: {
        IMAGE_DEFAULT_QUALITY: "medium",
        IMAGE_MAX_QUALITY: "high",
        IMAGE_SESSION_LIMIT: options.sessionLimit ?? 4,
        IMAGE_MODEL: "fictional-image-model",
      },
      log,
    },
    token,
    {
      ttlMs: options.ttlMs ?? 600_000,
      maxFiles: 8,
      maxBytes: 32 * 1024 * 1024,
      importTimeoutMs: 10_000,
    },
  );
  await new Promise<void>((resolve) =>
    service.http.listen(0, "127.0.0.1", resolve),
  );
  const address = service.http.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const clients: Client[] = [];
  return {
    url,
    logs,
    calls,
    client,
    service,
    async connect() {
      const mcp = new Client({ name: "fictional", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      await mcp.connect(transport as Transport);
      clients.push(mcp);
      return { client: mcp, transport };
    },
    post(path, session, init) {
      return fetch(new URL(path, url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "mcp-session-id": session,
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: init.body, duplex: "half" }),
      });
    },
    async close() {
      for (const mcp of clients) await mcp.close().catch(() => undefined);
      await service.close();
    },
  };
}

/** Run BP's attachment transfer: ticket, then upload with the token. */
export async function importImage(
  h: Harness,
  session: string,
  data: Buffer,
  filename = "photo.png",
  id = "00000000-0000-4000-8000-000000000001",
) {
  const input = {
    id,
    filename,
    size: data.length,
    sha256: sha256(data),
    limits: { files: 5, totalMiB: 50, expandedMiB: 100, expandedFiles: 500 },
  };
  const ticket = await h.post("/mcp/attachments/tickets", session, {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
  });
  const ticketBody = (await ticket.json()) as {
    token?: string;
    result?: Record<string, unknown>;
  };
  if (ticketBody.result)
    return { status: 200, body: { result: ticketBody.result } };
  const upload = await h.post("/mcp/attachments", session, {
    body: new Uint8Array(data),
    headers: {
      "x-bp-transfer-token": ticketBody.token ?? "",
      "content-length": String(data.length),
      "content-type": "application/octet-stream",
    },
  });
  return {
    status: upload.status,
    body: (await upload.json()) as {
      result?: Record<string, unknown>;
      error?: string;
    },
  };
}

/** Run BP's image export: ticket, then POST with the token. */
export async function exportImage(h: Harness, session: string, path: string) {
  const ticket = await h.post("/mcp/image-exports/tickets", session, {
    body: JSON.stringify({ path }),
    headers: { "content-type": "application/json" },
  });
  if (!ticket.ok)
    return {
      status: ticket.status,
      error: ((await ticket.json()) as { error: string }).error,
    };
  const { token: exportToken } = (await ticket.json()) as { token: string };
  const response = await h.post("/mcp/image-exports", session, {
    headers: { "x-bp-transfer-token": exportToken },
  });
  if (!response.ok)
    return {
      status: response.status,
      error: ((await response.json()) as { error: string }).error,
      token: exportToken,
    };
  const data = Buffer.from(await response.arrayBuffer());
  return {
    status: 200,
    data,
    token: exportToken,
    headers: response.headers,
  };
}
