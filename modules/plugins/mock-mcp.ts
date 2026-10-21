import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
/** Fictional local fixture. No production data, credentials, or message gateway. */
export async function startMockMcp(port = 0) {
  const sessions = new Map<
    string,
    { server: McpServer; transport: StreamableHTTPServerTransport }
  >();
  const http = createServer((req, res) => {
    void (async () => {
      if (req.url !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      const session = req.headers["mcp-session-id"];
      let pair =
        typeof session === "string" ? sessions.get(session) : undefined;
      if (!pair) {
        const server = new McpServer({
          name: "fictional-public-data",
          version: "1.0.0",
        });
        server.registerTool(
          "lookup",
          {
            description:
              "查询虚构资料。query=empty 返回空结果，query=error 返回工具错误。",
            inputSchema: { query: z.string() },
            annotations: { readOnlyHint: true },
          },
          async ({ query }) => {
            if (query === "slow")
              await new Promise((resolve) => setTimeout(resolve, 100));
            return {
              isError: query === "error" || query === "quota",
              ...(query === "quota"
                ? {
                    structuredContent: {
                      error: { code: "INSUFFICIENT_CREDITS" },
                    },
                  }
                : {}),
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    results:
                      query === "empty"
                        ? []
                        : [
                            {
                              title: "虚构资料",
                              text: "测试资料：蓝色小镇图书馆周二开放。",
                            },
                          ],
                  }),
                },
              ],
            };
          },
        );
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => {
            sessions.set(id, { server, transport });
          },
        });
        await server.connect(transport as Transport);
        pair = { server, transport };
      }
      await pair.transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("No mock address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await Promise.all([...sessions.values()].map((s) => s.server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
