import { it, expect } from "vitest";
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
