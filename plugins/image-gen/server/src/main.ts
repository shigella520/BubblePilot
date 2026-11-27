import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { readConfig } from "./config.js";
import { createMcpHttp } from "./http.js";
import { selectListenAddress } from "./listen.js";
import { DailyQuota } from "./quota.js";
import { jsonLogger } from "./tools.js";
import { imagesClient } from "./upstream.js";

function main() {
  const { config, token, apiKey } = readConfig();
  const host = selectListenAddress(
    networkInterfaces(),
    config.LISTEN_EXCLUDE_CIDR,
    config.LISTEN_HOST,
  );
  const service = createMcpHttp(
    {
      client: imagesClient({
        baseUrl: config.IMAGE_API_BASE_URL,
        apiKey,
        model: config.IMAGE_MODEL,
        timeoutMs: config.IMAGE_TIMEOUT_SECONDS * 1000,
        editField: config.IMAGE_EDIT_FIELD,
      }),
      quota: new DailyQuota(
        config.QUOTA_FILE,
        config.IMAGE_DAILY_LIMIT,
        config.IMAGE_QUOTA_TIMEZONE,
      ),
      config,
      log: jsonLogger,
    },
    token,
    {
      ttlMs: config.SESSION_TTL_SECONDS * 1000,
      maxFiles: config.WORKSPACE_MAX_FILES,
      maxBytes: config.WORKSPACE_MAX_MIB * 1024 * 1024,
      importTimeoutMs: config.ATTACHMENT_IMPORT_TIMEOUT_SECONDS * 1000,
    },
    config.MAX_MCP_SESSIONS,
  );
  // Health is served on loopback only so container checks never require the
  // MCP listener to be reachable outside its internal network.
  const health = createServer((req, res) => {
    res
      .writeHead(req.url === "/healthz" ? 200 : 404, {
        "content-type": "text/plain",
      })
      .end(req.url === "/healthz" ? "ok" : "");
  });
  service.http.once("error", () => {
    console.error("Image generation MCP listener failed to start");
    process.exit(1);
  });
  service.http.listen(config.PORT, host);
  health.listen(config.PORT + 1, "127.0.0.1");
  jsonLogger({ event: "listening", host, port: config.PORT });
  const stop = () => {
    const deadline = setTimeout(() => process.exit(0), 15000);
    deadline.unref();
    health.close();
    void service.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
try {
  main();
} catch (error: unknown) {
  console.error(
    `Image generation MCP startup failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}
