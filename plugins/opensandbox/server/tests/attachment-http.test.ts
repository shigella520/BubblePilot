import type { TransferInput } from "../src/attachment-contract.js";
import { it, expect, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpHttp } from "../src/http.js";
import { fixture } from "./support.js";
it("binds single-use transfer tickets to the authenticated MCP session and preserves imports", async () => {
  const { pool, backend } = fixture(1, 600000, {
    createSeconds: 120,
    importSeconds: 150,
  });
  const original = backend.create;
  const uploads = vi.fn(
    async (input: TransferInput, body: AsyncIterable<Uint8Array>) => {
      const chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from("fictional,csv\n1,2"));
      return {
        status: "imported" as const,
        sandbox_path: `/workspace/attachments/${input.id}/${input.filename}`,
        size: input.size,
        sha256: input.sha256,
        expandedBytes: 0,
        expandedFiles: 0,
      };
    },
  );
  vi.spyOn(backend, "create").mockImplementation(async (owner, signal) => ({
    ...(await original(owner, signal)),
    upload: uploads,
  }));
  const server = createMcpHttp(pool, "fictional-token");
  expect(server.http.requestTimeout).toBe(150000);
  expect(server.http.headersTimeout).toBe(10000);
  await new Promise<void>((r) => server.http.listen(0, "127.0.0.1", r));
  const a = server.http.address();
  if (!a || typeof a === "string") throw new Error("address");
  const url = `http://127.0.0.1:${a.port}/mcp`;
  const clients: Client[] = [];
  const connect = async () => {
    const client = new Client({ name: "test", version: "1" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: "Bearer fictional-token" } },
    });
    await client.connect(transport as Transport);
    return { client, transport };
  };
  try {
    const first = await connect(),
      other = await connect();
    expect(first.client.getServerCapabilities()?.experimental).toMatchObject({
      "io.bubblepilot/attachments": { version: 1 },
    });
    expect(backend.create).not.toHaveBeenCalled();
    const data = Buffer.from("fictional,csv\n1,2");
    const input = {
      id: randomUUID(),
      filename: "file.csv",
      size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      limits: { files: 3, totalMiB: 20, expandedMiB: 50, expandedFiles: 200 },
    };
    const headers = {
      authorization: "Bearer fictional-token",
      "mcp-session-id": first.transport.sessionId!,
    };
    const response = await fetch(url + "/attachments/tickets", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    const ticket = (await response.json()) as { token: string };
    expect(response.status).toBe(200);
    expect(ticket).toMatchObject({ expiresInSeconds: 150 });
    const upload = async (session: string) =>
      fetch(url + "/attachments", {
        method: "POST",
        headers: {
          ...headers,
          "mcp-session-id": session,
          "x-bp-transfer-token": ticket.token,
          "content-length": String(data.length),
        },
        body: data,
      });
    expect((await upload(other.transport.sessionId!)).status).toBe(403);
    const imported = await upload(first.transport.sessionId!);
    expect(imported.status).toBe(200);
    await imported.text();
    expect((await upload(first.transport.sessionId!)).status).toBe(403);
    const repeated = await fetch(url + "/attachments/tickets", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    expect(await repeated.json()).toMatchObject({
      result: { status: "imported" },
    });
    expect(uploads).toHaveBeenCalledTimes(1);
    expect(
      (await first.client.callTool({ name: "prepare_sandbox", arguments: {} }))
        .structuredContent,
    ).toMatchObject({ status: "reused" });
    await first.transport.terminateSession();
    await pool.sweep();
    expect(pool.used).toBe(0);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await server.close();
  }
});
