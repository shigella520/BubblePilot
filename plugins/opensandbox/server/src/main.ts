import { readConfig } from "./config.js";
import { sdkBackend } from "./backend.js";
import { SandboxPool } from "./lifecycle.js";
import { createMcpHttp } from "./http.js";

async function main() {
  const { config, apiKey, token } = readConfig();
  const backend = sdkBackend(config, apiKey);
  const pool = new SandboxPool(
    backend,
    config.MAX_CONCURRENT_SANDBOXES,
    config.SANDBOX_TTL_SECONDS * 1000,
  );
  await pool.reconcile();
  const service = createMcpHttp(pool, token, config.MAX_MCP_SESSIONS);
  service.http.listen(config.PORT, "0.0.0.0");
  const stop = () => {
    const deadline = setTimeout(() => process.exit(0), 15000);
    deadline.unref();
    void service
      .close()
      .finally(() => backend.close())
      .finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
void main().catch(() => {
  console.error(
    "OpenSandbox MCP startup failed; check configuration and orphan reconciliation.",
  );
  process.exitCode = 1;
});
