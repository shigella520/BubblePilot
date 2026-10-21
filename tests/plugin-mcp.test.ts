import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startMockMcp } from "../modules/plugins/mock-mcp.js";
import { PluginMcp } from "../modules/plugins/plugin-mcp.js";
let server: Awaited<ReturnType<typeof startMockMcp>>;
beforeAll(async () => {
  server = await startMockMcp();
});
afterAll(async () => {
  await server.close();
});
describe("MCP transport with fictional HTTP server", () => {
  it("initializes, discovers, validates and calls without losing structured status", async () => {
    const c = new PluginMcp();
    try {
      await c.connect({
        url: server.url,
        allowPrivate: true,
        auth: "none",
        header: "X-Api-Key",
      });
      const tools = await c.discover("fictional");
      expect(tools.map((t) => t.definition.name)).toEqual(["lookup"]);
      const tool = tools[0]!;
      expect(
        await c.call(
          tool,
          { query: "library" },
          AbortSignal.timeout(5000),
          5000,
        ),
      ).toMatchObject({ status: "success" });
      expect(
        await c.call(tool, { query: "error" }, AbortSignal.timeout(5000), 5000),
      ).toMatchObject({ status: "error" });
      expect(
        await c.call(tool, { query: "quota" }, AbortSignal.timeout(5000), 5000),
      ).toMatchObject({
        status: "error",
        errorCode: "PLUGIN_QUOTA_EXHAUSTED",
        contentAvailable: false,
        retryInThisAnswer: false,
      });
      await expect(
        c.call(tool, { query: "slow" }, AbortSignal.timeout(10), 5000),
      ).rejects.toThrow("MCP_CANCELLED");
      await expect(
        c.call(tool, { query: 1 }, AbortSignal.timeout(5000), 5000),
      ).rejects.toThrow();
    } finally {
      await c.close();
    }
  });
  it("rejects private service without approval", async () => {
    const c = new PluginMcp();
    try {
      await expect(
        c.connect({
          url: server.url,
          allowPrivate: false,
          auth: "none",
          header: "X-Api-Key",
        }),
      ).rejects.toThrow();
    } finally {
      await c.close();
    }
  });
});
