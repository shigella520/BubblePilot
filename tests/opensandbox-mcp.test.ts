import { it, expect } from "vitest";
import { createMcpHttp } from "../plugins/opensandbox/server/src/http.js";
import { fixture } from "../plugins/opensandbox/server/tests/support.js";
import { PluginMcp } from "../modules/plugins/plugin-mcp.js";
import {
  strictToolParameters,
  restoreToolArguments,
} from "../modules/ai/tool-schema.js";
it("discovers the sandbox through the application client and normalizes strict optional arguments", async () => {
  const { pool } = fixture();
  const service = createMcpHttp(pool, "fictional-sandbox-token");
  await new Promise<void>((resolve) =>
    service.http.listen(0, "127.0.0.1", resolve),
  );
  const address = service.http.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const client = new PluginMcp();
  try {
    await client.connect({
      url: `http://127.0.0.1:${address.port}/mcp`,
      allowPrivate: true,
      auth: "bearer",
      header: "Authorization",
      secret: "fictional-sandbox-token",
    });
    const tools = await client.discover("opensandbox");
    for (const tool of tools)
      expect(() => strictToolParameters(tool.definition)).not.toThrow();
    const prepare = tools.find(
      (tool) => tool.definition.name === "prepare_sandbox",
    )!;
    const run = tools.find((tool) => tool.definition.name === "run_command")!;
    expect(
      await client.call(prepare, {}, AbortSignal.timeout(5000), 5000),
    ).toMatchObject({ status: "success" });
    const args: unknown = JSON.parse(
      restoreToolArguments(
        run.definition.parameters,
        JSON.stringify({
          command: "python -c 'print(4)'",
          timeout_seconds: null,
        }),
      ),
    );
    expect(args).toEqual({ command: "python -c 'print(4)'" });
    expect(
      await client.call(run, args, AbortSignal.timeout(5000), 5000),
    ).toMatchObject({
      status: "success",
      structuredContent: { exitCode: 0, stdout: "4" },
    });
  } finally {
    await client.close();
    await service.close();
  }
});
