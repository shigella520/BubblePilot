import type * as ResultStore from "../modules/plugins/plugin-result-store.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { PluginMcp } from "../modules/plugins/plugin-mcp.js";
// Exercise the real streaming boundary without allocating 30 MiB per parallel test worker.
vi.mock("../modules/plugins/plugin-result-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ResultStore>();
  return {
    ...actual,
    resultLimits: { ...actual.resultLimits, responseBytes: 64 * 1024 },
  };
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  tools: Tool[],
  result: CallToolResult,
  options: { repeatCursor?: boolean; status?: number } = {},
) {
  const server = new Server(
    { name: "fictional", version: "1" },
    { capabilities: { tools: {} } },
  );
  let calls = 0;
  server.setRequestHandler(ListToolsRequestSchema, (request) => ({
    tools: request.params?.cursor ? tools.slice(1) : tools.slice(0, 1),
    ...(!request.params?.cursor || options.repeatCursor
      ? { nextCursor: "page-two" }
      : {}),
  }));
  server.setRequestHandler(CallToolRequestSchema, () => {
    calls++;
    return result;
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
  });
  await server.connect(transport as Transport);
  const http = createServer((req, res) => {
    if (options.status) {
      res.writeHead(options.status).end();
      return;
    }
    void transport.handleRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    await server.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("fixture");
  const client = new PluginMcp();
  cleanup.push(() => client.close());
  await client.connect({
    url: `http://127.0.0.1:${address.port}`,
    allowPrivate: true,
    auth: "none",
    header: "X-Api-Key",
  });
  return { client, calls: () => calls };
}
const inputSchema: Tool["inputSchema"] = {
  type: "object",
  properties: {
    schema: {
      type: "object",
      propertyNames: { pattern: "^[a-z]+$" },
      additionalProperties: { type: "integer" },
    },
  },
  required: ["schema"],
  additionalProperties: false,
};
const outputSchema: Tool["outputSchema"] = {
  type: "object",
  properties: { count: { type: "integer" } },
  required: ["count"],
};
const tool: Tool = { name: "fictional_extract", inputSchema, outputSchema };
describe("MCP discovery and result contracts", () => {
  it("discovers pages without rejecting maps and preserves output contracts", async () => {
    const { client, calls } = await fixture(
      [tool, { name: "no_args", inputSchema: { type: "object" } }],
      { content: [], structuredContent: { count: 2 } },
    );
    const tools = await client.discover("fixture");
    expect(tools).toHaveLength(2);
    expect(tools[0]!.outputSchema).toEqual(outputSchema);
    await expect(
      client.call(
        tools[0]!,
        { schema: { "bad-key": 2 } },
        AbortSignal.timeout(5000),
        5000,
      ),
    ).rejects.toThrow("INVALID_TOOL_ARGUMENTS");
    expect(calls()).toBe(0);
    expect(
      await client.call(
        tools[0]!,
        { schema: { price: 2 } },
        AbortSignal.timeout(5000),
        5000,
      ),
    ).toMatchObject({ status: "success", structuredContent: { count: 2 } });
    expect(calls()).toBe(1);
  });
  it("rejects invalid structured output without replaying calls", async () => {
    const { client, calls } = await fixture([tool], {
      content: [],
      structuredContent: { count: "private-value" },
    });
    const [t] = await client.discover("fixture");
    await expect(
      client.call(t!, { schema: {} }, AbortSignal.timeout(5000), 5000),
    ).rejects.toMatchObject({ code: "PLUGIN_MCP_OUTPUT_INVALID" });
    expect(calls()).toBe(1);
  });
  it("keeps tool isError distinct and does not demand successful output on errors", async () => {
    const { client } = await fixture(
      [{ name: "first_page", inputSchema: { type: "object" } }, tool],
      {
        isError: true,
        structuredContent: { error: "fictional" },
        content: [{ type: "text", text: "fictional failure" }],
      },
    );
    const [, t] = await client.discover("fixture");
    expect(
      await client.call(t!, { schema: {} }, AbortSignal.timeout(5000), 5000),
    ).toMatchObject({ status: "error" });
  });
  it("rejects repeated pagination cursors and task-only tools explicitly", async () => {
    const { client } = await fixture(
      [],
      { content: [] },
      { repeatCursor: true },
    );
    await expect(client.discover("fixture")).rejects.toThrow(
      "INVALID_PAGINATION",
    );
    const task = await fixture(
      [{ ...tool, execution: { taskSupport: "required" } }],
      { content: [] },
    );
    await expect(task.client.discover("fixture")).rejects.toThrow(
      "MCP_TASK_REQUIRED",
    );
  });
  it.each([401, 403])(
    "classifies HTTP %s without exposing remote errors",
    async (status) => {
      await expect(
        fixture([], { content: [] }, { status }),
      ).rejects.toMatchObject({ code: "PLUGIN_REMOTE_AUTH_DENIED" });
    },
  );
});

it("reports the network response cap distinctly from MCP protocol failures", async () => {
  const { client } = await fixture(
    [{ name: "large", inputSchema: { type: "object", properties: {} } }],
    { content: [{ type: "text", text: "x".repeat(64 * 1024 + 1) }] },
  );
  const tools = await client.discover("fixture");
  await expect(
    client.call(tools[0]!, {}, AbortSignal.timeout(10000), 10000),
  ).rejects.toMatchObject({ code: "PLUGIN_RESPONSE_TOO_LARGE" });
}, 15000);
