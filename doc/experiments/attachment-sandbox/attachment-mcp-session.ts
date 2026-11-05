// Disposable local probe: existing MCP lifecycle + out-of-band SDK upload.
// This is not the proposed authenticated attachment transfer endpoint.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sdkBackend } from "../../../plugins/opensandbox/server/src/backend.js";
import { SandboxPool } from "../../../plugins/opensandbox/server/src/lifecycle.js";
import { createMcpHttp } from "../../../plugins/opensandbox/server/src/http.js";
import { configSchema } from "../../../plugins/opensandbox/server/src/config.js";
const require = createRequire(
  new URL("../../../plugins/opensandbox/server/package.json", import.meta.url),
);
const { Sandbox, ConnectionConfig } = require("@alibaba-group/opensandbox");
const url = process.env.SPIKE_URL ?? "http://127.0.0.1:28090";
assert(["127.0.0.1", "localhost"].includes(new URL(url).hostname));
assert(process.env.SPIKE_KEY_FILE);
const key = (await readFile(process.env.SPIKE_KEY_FILE, "utf8")).trim();
const config = configSchema.parse({
  OPENSANDBOX_URL: url,
  SANDBOX_IMAGE: process.env.SPIKE_IMAGE,
  ADAPTER_INSTANCE_ID: `spike-${randomUUID()}`,
  MCP_TOKEN_FILE: "unused",
  OPENSANDBOX_API_KEY_FILE: "unused",
});
const backend = sdkBackend(config, key),
  pool = new SandboxPool(backend, 1, 300000);
const token = randomUUID();
const service = createMcpHttp(pool, token);
await new Promise<void>((r) => service.http.listen(0, "127.0.0.1", r));
const addr = service.http.address();
assert(addr && typeof addr !== "string");
const endpoint = new URL(`http://127.0.0.1:${addr.port}/mcp`);
const clients: Client[] = [];
async function connect() {
  const c = new Client({ name: "local-spike", version: "1.0" });
  const t = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await c.connect(t);
  clients.push(c);
  return { c, t };
}
async function call(
  c: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  return (await c.callTool({ name, arguments: args })).structuredContent!;
}
const log = (name: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ name, ...extra }));
let upload: any;
let cfg: any;
try {
  assert.equal((await fetch(endpoint)).status, 401);
  const a = await connect(),
    b = await connect();
  assert.equal((await a.c.listTools()).tools.length, 4);
  assert.equal((await backend.owned()).length, 0);
  log("discovery-no-sandbox-and-auth");
  assert.equal((await call(a.c, "prepare_sandbox")).status, "created");
  assert.equal((await call(b.c, "prepare_sandbox")).status, "capacity_busy");
  const ids = await backend.owned();
  assert.equal(ids.length, 1);
  cfg = new ConnectionConfig({
    domain: url,
    apiKey: key,
    useServerProxy: true,
    disableMetrics: true,
  });
  upload = await Sandbox.connect({ sandboxId: ids[0], connectionConfig: cfg });
  await upload.files.writeFiles([
    { path: "/workspace/first.txt", data: "第一阶段: 12" },
  ]);
  assert.equal(
    (await call(a.c, "read_file", { path: "/workspace/first.txt" })).text,
    "第一阶段: 12",
  );
  await upload.files.writeFiles([
    { path: "/workspace/second.txt", data: "第二阶段: 34" },
  ]);
  assert.equal(
    (await call(a.c, "read_file", { path: "/workspace/second.txt" })).text,
    "第二阶段: 34",
  );
  assert.equal((await call(a.c, "prepare_sandbox")).status, "reused");
  assert.deepEqual(await backend.owned(), ids);
  log("same-mcp-session-two-stage-upload");
  const unsafe = await a.c.callTool({
    name: "read_file",
    arguments: { path: "/workspace/../tmp/other" },
  });
  assert(unsafe.isError);
  log("existing-file-tool-path-boundary");
  const old = a.t.sessionId!;
  await a.t.terminateSession();
  await pool.sweep();
  assert.equal((await backend.owned()).length, 0);
  assert.equal(
    (
      await fetch(endpoint, {
        headers: { Authorization: `Bearer ${token}`, "mcp-session-id": old },
      })
    ).status,
    404,
  );
  log("delete-session-cleanup-and-revoke");
  assert.equal((await call(b.c, "prepare_sandbox")).status, "created");
  const missing = await b.c.callTool({
    name: "read_file",
    arguments: { path: "/workspace/first.txt" },
  });
  assert(missing.isError);
  log("next-session-cannot-read-previous");
  await assert.rejects(b.t.terminateSession(), (e: any) => e.code === 404);
  await pool.sweep();
  log("failed-command-invalidates-session");
} finally {
  await Promise.all(clients.map((c) => c.close()));
  await service.close();
  for (const id of await backend.owned()) await backend.remove(id);
  assert.equal((await backend.owned()).length, 0);
  log("final-cleanup", { remaining: 0 });
  if (upload) await upload.close();
  if (cfg) await cfg.closeTransport();
  await backend.close();
}
