import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpHttp } from "../src/http.js";
import { fixture } from "./support.js";
import { imageExportCommand, readImageResponse } from "../src/image-export.js";
it.each([false, true])(
  "authenticates export tickets, binds session and consumes once, generic=%s",
  async (file) => {
    const exportPath = file ? "/file-exports" : "/image-exports";
    const { pool, backend } = fixture(2, 600000);
    const original = backend.create;
    const bytes = Buffer.from("fictional-png-transport");
    const exported = vi.fn().mockResolvedValue(bytes);
    vi.spyOn(backend, "create").mockImplementation(async (owner, signal) => ({
      ...(await original(owner, signal)),
      exportImage: exported,
    }));
    const server = createMcpHttp(pool, "fictional-token");
    await new Promise<void>((r) => server.http.listen(0, "127.0.0.1", r));
    const address = server.http.address();
    if (!address || typeof address === "string") throw new Error("address");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const clients: Client[] = [];
    async function connect() {
      const client = new Client({ name: "test", version: "1" });
      clients.push(client);
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: "Bearer fictional-token" } },
      });
      await client.connect(transport as Transport);
      return { client, transport };
    }
    try {
      const a = await connect(),
        b = await connect();
      const headers = {
        authorization: "Bearer fictional-token",
        "mcp-session-id": a.transport.sessionId!,
        "content-type": "application/json",
      };
      expect(
        a.client.getServerCapabilities()?.experimental?.[
          "io.bubblepilot/image-export"
        ],
      ).toMatchObject({ version: 1 });
      expect(
        (
          await fetch(url + exportPath + "/tickets", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: "/workspace/a.png" }),
          })
        ).status,
      ).toBe(401);
      const ticket = (await (
        await fetch(url + exportPath + "/tickets", {
          method: "POST",
          headers,
          body: JSON.stringify({ path: "/workspace/a.png" }),
        })
      ).json()) as { token: string };
      const send = (session: string) =>
        fetch(url + exportPath, {
          method: "POST",
          headers: {
            ...headers,
            "mcp-session-id": session,
            "x-bp-transfer-token": ticket.token,
          },
        });
      expect((await send(b.transport.sessionId!)).status).toBe(403);
      await a.client.callTool({ name: "prepare_sandbox", arguments: {} });
      const response = await send(a.transport.sessionId!);
      expect(
        await readImageResponse(response, new AbortController().signal),
      ).toEqual(bytes);
      expect(exported).toHaveBeenCalledOnce();
      expect(exported.mock.calls[0]?.[2]).toBe(file);
      expect(
        a.client.getServerCapabilities()?.experimental?.[
          "io.bubblepilot/file-export"
        ],
      ).toMatchObject({ version: 1 });
      expect((await send(a.transport.sessionId!)).status).toBe(403);
      expect(
        (
          await fetch(url + exportPath + "/tickets", {
            method: "POST",
            headers,
            body: JSON.stringify({ path: "/workspace/../outside" }),
          })
        ).status,
      ).toBe(422);
    } finally {
      await Promise.all(clients.map((c) => c.close()));
      await server.close();
    }
  },
);
it("checks actual byte counts and hashes without shell interpolation", async () => {
  const data = Buffer.from("fictional"),
    signal = new AbortController().signal;
  const response = (length: number, hash: string) =>
    new Response(data, {
      headers: { "content-length": String(length), "x-content-sha256": hash },
    });
  const hash = createHash("sha256").update(data).digest("hex");
  expect(await readImageResponse(response(data.length, hash), signal)).toEqual(
    data,
  );
  await expect(
    readImageResponse(response(data.length - 1, hash), signal),
  ).rejects.toThrow();
  await expect(
    readImageResponse(response(data.length, "0".repeat(64)), signal),
  ).rejects.toThrow();
  expect(
    imageExportCommand({
      path: "/workspace/$(echo secret)'a.png",
      port: 1,
      token: "fictional",
      seconds: 1,
    }),
  ).not.toContain("echo secret");
});
