import { startMockMcp } from "../modules/plugins/mock-mcp.js";
const server = await startMockMcp(
  Number(process.env.PLUGIN_MOCK_PORT ?? 18769),
);
process.stdout.write(`Fictional MCP listening at ${server.url}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void server.close());
