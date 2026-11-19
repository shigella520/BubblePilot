import { expect, it, vi } from "vitest";
import { createMcpHttp } from "../plugins/opensandbox/server/src/http.js";
import { fixture } from "../plugins/opensandbox/server/tests/support.js";
import { PluginMcp } from "../modules/plugins/plugin-mcp.js";
it("discovers separately approved file export and transfers raw document bytes over authenticated MCP", async () => {
  const { pool, backend } = fixture();
  const create = backend.create;
  const bytes = Buffer.from("fictional report\n".repeat(10000));
  const exportFile = vi.fn().mockResolvedValue(bytes);
  vi.spyOn(backend, "create").mockImplementation(async (owner, signal) => ({
    ...(await create(owner, signal)),
    exportImage: exportFile,
  }));
  const server = createMcpHttp(pool, "fictional-file-token");
  await new Promise<void>((r) => server.http.listen(0, "127.0.0.1", r));
  const addr = server.http.address();
  if (!addr || typeof addr === "string") throw new Error("fixture");
  const client = new PluginMcp();
  try {
    await client.connect({
      url: `http://127.0.0.1:${addr.port}/mcp`,
      allowPrivate: true,
      auth: "bearer",
      header: "Authorization",
      secret: "fictional-file-token",
    });
    const tools = await client.discover("sandbox");
    const prepare = tools.find((t) => t.definition.name === "prepare_sandbox")!;
    expect(prepare.fileExportVersion).toBe(1);
    expect(prepare.imageExportVersion).toBe(1);
    await client.call(prepare, {}, new AbortController().signal, 5000);
    expect(
      await client.exportImage(
        "/workspace/report.txt",
        new AbortController().signal,
        true,
      ),
    ).toEqual(bytes);
    expect(exportFile.mock.calls[0]?.[2]).toBe(true);
    expect(exportFile.mock.calls[0]?.[0]).toBe("/workspace/report.txt");
  } finally {
    await client.close();
    await server.close();
    vi.restoreAllMocks();
  }
});
