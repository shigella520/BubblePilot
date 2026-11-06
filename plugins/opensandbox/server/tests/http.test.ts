import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpHttp } from "../src/http.js";
import { fixture } from "./support.js";

it("authenticates, discovers without allocation, separates sessions and revokes on DELETE", async () => {
  const { pool, backend } = fixture();
  const service = createMcpHttp(pool, "fictional-test-token");
  await new Promise<void>((resolve) =>
    service.http.listen(0, "127.0.0.1", resolve),
  );
  const address = service.http.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const clients: Client[] = [];
  try {
    expect((await fetch(url)).status).toBe(401);
    const connect = async () => {
      const client = new Client({ name: "fictional", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: { Authorization: "Bearer fictional-test-token" },
        },
      });
      await client.connect(transport as Transport);
      clients.push(client);
      return { client, transport };
    };
    const a = await connect(),
      b = await connect();
    const listed = await a.client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "prepare_sandbox",
      "run_command",
      "read_file",
      "write_file",
    ]);
    expect(
      listed.tools.find((t) => t.name === "run_command")!.inputSchema.properties
        ?.timeout_seconds,
    ).toMatchObject({ default: 60, maximum: 120 });
    expect(backend.create).not.toHaveBeenCalled();
    expect(
      (await a.client.callTool({ name: "prepare_sandbox", arguments: {} }))
        .structuredContent,
    ).toMatchObject({ status: "created" });
    expect(
      (await b.client.callTool({ name: "prepare_sandbox", arguments: {} }))
        .structuredContent,
    ).toMatchObject({ status: "capacity_busy" });
    expect(
      (
        await a.client.callTool({
          name: "read_file",
          arguments: { path: "/workspace/../secret" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await a.client.callTool({
          name: "run_command",
          arguments: { command: "python -c 'print(4)'" },
        })
      ).structuredContent,
    ).toMatchObject({ exitCode: 0, stdout: "4" });
    const old = a.transport.sessionId!;
    await a.transport.terminateSession();
    expect(
      (
        await fetch(url, {
          headers: {
            Authorization: "Bearer fictional-test-token",
            "mcp-session-id": old,
          },
        })
      ).status,
    ).toBe(404);
    await pool.sweep();
    expect(
      (await b.client.callTool({ name: "prepare_sandbox", arguments: {} }))
        .structuredContent,
    ).toMatchObject({ status: "created" });
    await b.transport.terminateSession();
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await service.close();
  }
});

it("sends timeout errors before closing the invalidated MCP session, even with a stalled backend and slow response", async () => {
  const { pool, run } = fixture(1, 600000, undefined, {
    defaultSeconds: 1,
    maxSeconds: 2,
  });
  const service = createMcpHttp(pool, "fictional-token");
  await new Promise<void>((r) => service.http.listen(0, "127.0.0.1", r));
  const address = service.http.address();
  if (!address || typeof address === "string") throw new Error("address");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: "deadline-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: "Bearer fictional-token" } },
  });
  // Preserve the method for explicit .call(this) inside the transport spy.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalSend = StreamableHTTPServerTransport.prototype.send;
  vi.spyOn(StreamableHTTPServerTransport.prototype, "send").mockImplementation(
    async function (this: StreamableHTTPServerTransport, message, options) {
      if ("result" in message && message.result.isError)
        await new Promise((r) => setTimeout(r, 1300));
      return originalSend.call(this, message, options);
    },
  );
  try {
    await client.connect(transport as Transport);
    const listed = await client.listTools();
    expect(
      listed.tools.find((t) => t.name === "run_command")!.inputSchema.properties
        ?.timeout_seconds,
    ).toMatchObject({ default: 1, maximum: 2 });
    await client.callTool({ name: "prepare_sandbox", arguments: {} });
    const count = run.mock.calls.length;
    const invalid = await client.callTool({
      name: "run_command",
      arguments: { command: "ignored", timeout_seconds: 3 },
    });
    expect(invalid.isError).toBe(true);
    expect(run).toHaveBeenCalledTimes(count);
    // Ignore cancellation forever, as a broken remote stream might do.
    run.mockImplementationOnce(() => new Promise(() => {}));
    const start = Date.now();
    const result = await client.callTool(
      { name: "run_command", arguments: { command: "fictional slow command" } },
      undefined,
      { timeout: 6000 },
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        status: "command_timeout_session_invalidated_do_not_replay",
      },
    });
    expect(Date.now() - start).toBeLessThan(5000);
    await expect(
      client.callTool(
        { name: "run_command", arguments: { command: "no replay" } },
        undefined,
        { timeout: 1000 },
      ),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(count + 1);
    await pool.sweep();
    expect(pool.used).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await client.close();
    await service.close();
  }
}, 10000);
