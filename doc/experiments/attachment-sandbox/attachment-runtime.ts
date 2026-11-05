// Local real transport acceptance. Fictional gateway; actual PluginSession,
// binary endpoint, OpenSandbox API and sandbox commands. No production inputs.
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { sdkBackend } from "../../../plugins/opensandbox/server/src/backend.js";
import { SandboxPool } from "../../../plugins/opensandbox/server/src/lifecycle.js";
import { createMcpHttp } from "../../../plugins/opensandbox/server/src/http.js";
import { configSchema } from "../../../plugins/opensandbox/server/src/config.js";
import { PluginMcp } from "../../../modules/plugins/plugin-mcp.js";
import { PluginSession } from "../../../modules/plugins/plugin-session.js";
import { AttachmentSession } from "../../../modules/attachments/attachment-session.js";
import { AttachmentStore } from "../../../modules/attachments/attachment-store.js";
import { attachmentLimitsSchema } from "../../../modules/attachments/attachment-policy.js";
import { BlueBubblesAttachmentDownloader } from "../../../modules/integrations/bluebubbles/attachment-download.js";
import { AgentToolRegistry } from "../../../modules/ai/agent-tool-registry.js";
import type {
  InstalledPlugin,
  Connection,
} from "../../../modules/plugins/plugin-types.js";
import type { PluginService } from "../../../modules/plugins/plugin-service.js";
import type { BlueBubblesSettingsService } from "../../../modules/integrations/bluebubbles/settings-service.js";
import { digest } from "../../../modules/plugins/plugin-package.js";
const url = process.env.SPIKE_URL ?? "http://127.0.0.1:28090";
assert(["localhost", "127.0.0.1"].includes(new URL(url).hostname));
assert(process.env.SPIKE_KEY_FILE);
const key = (await readFile(process.env.SPIKE_KEY_FILE, "utf8")).trim();
const config = configSchema.parse({
  OPENSANDBOX_URL: url,
  SANDBOX_IMAGE:
    "python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704",
  ADAPTER_INSTANCE_ID: `attachment-test-${randomUUID()}`,
  MCP_TOKEN_FILE: "unused",
  OPENSANDBOX_API_KEY_FILE: "unused",
});
// Permit the preexisting LOCAL development runtime by exact digest, only here.
if (process.env.SPIKE_IMAGE) {
  assert(
    /^(python:3\.12-slim|bubblepilot-sandbox-python)@sha256:[a-f0-9]{64}$/.test(
      process.env.SPIKE_IMAGE,
    ),
  );
  config.SANDBOX_IMAGE = process.env.SPIKE_IMAGE;
}
if (config.SANDBOX_IMAGE.startsWith("bubblepilot-sandbox-python@")) {
  const sdk = await import(
    new URL(
      "../../../plugins/opensandbox/server/node_modules/@alibaba-group/opensandbox/dist/index.js",
      import.meta.url,
    ).href
  );
  const create = sdk.Sandbox.create;
  sdk.Sandbox.create = (options: Record<string, unknown>) =>
    create.call(sdk.Sandbox, {
      ...options,
      platform: { os: "linux", arch: "amd64" },
    });
}
const backend = sdkBackend(config, key),
  pool = new SandboxPool(backend, 1, 300000);
const token = randomUUID();
const server = createMcpHttp(pool, token);
await new Promise<void>((r) => server.http.listen(0, "127.0.0.1", r));
const address = server.http.address();
assert(address && typeof address !== "string");
const connection: Connection = {
  url: `http://127.0.0.1:${address.port}/mcp`,
  auth: "bearer",
  secret: token,
  allowPrivate: true,
  header: "X-Api-Key",
};
const fixtureFiles: Record<string, { data: Buffer; mimeType: string }> = {};
if (process.env.SPIKE_FIXTURE_DIR)
  for (const [ext, mimeType] of Object.entries({
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pdf: "application/pdf",
    html: "text/html",
    yaml: "application/yaml",
    png: "image/png",
    zip: "application/zip",
  }))
    fixtureFiles[ext] = {
      data: await readFile(
        join(process.env.SPIKE_FIXTURE_DIR, `sample.${ext}`),
      ),
      mimeType,
    };
const gateway = createServer((req, res) => {
  const u = new URL(req.url!, "http://localhost");
  assert.equal(u.searchParams.get("password"), "fictional-gateway-key");
  assert.equal(u.searchParams.get("original"), "true");
  const id = u.pathname.split("/").at(-2)!;
  if (fixtureFiles[id]) {
    res
      .writeHead(200, {
        "content-length": String(fixtureFiles[id].data.length),
      })
      .end(fixtureFiles[id].data);
    return;
  }
  const data = u.pathname.includes("yesterday")
    ? "地区,金额\n东,10\n西,20\n"
    : "地区,金额\n东,7\n";
  res
    .writeHead(200, { "content-length": String(Buffer.byteLength(data)) })
    .end(data);
});
await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
const ga = gateway.address();
assert(ga && typeof ga !== "string");
const downloader = new BlueBubblesAttachmentDownloader({
  resolve: async () => ({
    serverUrl: `http://127.0.0.1:${ga.port}`,
    accessToken: "fictional-gateway-key",
  }),
} as BlueBubblesSettingsService);
const root = await mkdtemp(join(tmpdir(), "bp-attachment-acceptance-"));
const store = new AttachmentStore(root);
await store.init();
let plugins: PluginSession | undefined;
let attachments: AttachmentSession | undefined;
const probe = new PluginMcp();
const log = (name: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ name, ...extra }));
try {
  await probe.connect(connection);
  const tools = await probe.discover("sandbox");
  assert.equal(probe.attachmentVersion(), 1);
  await probe.close();
  assert.equal((await backend.owned()).length, 0);
  log("discover-no-allocation");
  const plugin: InstalledPlugin = {
    id: randomUUID(),
    name: "Fictional sandbox",
    enabled: true,
    version: 1,
    revision: "test",
    package: {
      name: "test",
      version: "1",
      description: "test",
      format: "portable-1",
      skills: [],
      servers: [],
      files: {},
      hash: "test",
    },
    config: {
      connections: { sandbox: connection },
      tools,
      disabledSkills: [],
      disabledTools: [],
    },
  };
  plugins = new PluginSession(
    {
      get: async () => plugin,
      trustedHosts: async () => [],
    } as unknown as PluginService,
    [structuredClone(plugin)],
  );
  const files = [
    {
      providerAttachmentId: "yesterday",
      fileName: "昨天.csv",
      mimeType: "text/csv",
      sizeBytes: null,
    },
    {
      providerAttachmentId: "today",
      fileName: "今天.csv",
      mimeType: "text/csv",
      sizeBytes: null,
    },
  ];
  const sources = {
    resolve: async (_scope: any, id: string, index: number) => ({
      messageId: id,
      providerMessageId: id,
      attachment: files[id === "historical" ? 0 : 1]!,
      attachmentIndex: index,
    }),
  };
  attachments = new AttachmentSession(
    {
      config: {
        enabled: true,
        pluginId: plugin.id,
        server: "sandbox",
        limits: attachmentLimitsSchema.parse({}),
      },
      scope: {
        provider: "bluebubbles",
        providerChatId: "fictional-chat",
        triggerMessageId: "current",
      },
      current: { providerMessageId: "current", attachments: [files[1]!] },
    },
    plugins,
    sources,
    downloader,
    store,
  );
  let registry = new AgentToolRegistry();
  plugins.register(registry);
  attachments.register(registry);
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = Date.now();
    const tool = registry.get(name)!;
    const r = await tool.execute(JSON.stringify(args), {
      signal: AbortSignal.timeout(45000),
      deadline: Date.now() + 45000,
      maxOutputCharacters: 64000,
    });
    const result = JSON.parse(typeof r === "string" ? r : r.text);
    assert.notEqual(result.status, "unavailable", JSON.stringify(result));
    log(name, { ms: Date.now() - t });
    return result;
  };
  const command = async (code: string) => {
    const name = `ext_${digest([plugin.id, "sandbox", "run_command"]).slice(0, 24)}`;
    const result = await call(name, {
      arguments_json: JSON.stringify({ command: code, timeout_seconds: 25 }),
    });
    assert.equal(
      result.structuredContent?.status,
      "completed",
      JSON.stringify(result),
    );
    return result.structuredContent;
  };
  const first = attachments.catalogue({
    id: "historical",
    providerMessageId: "historical",
    attachments: [files[0]!],
  }).entries[0]!.attachment_ref!;
  const second = attachments.currentCatalogue().entries[0]!.attachment_ref!;
  const a = await call("import_chat_attachment", { attachment_ref: first });
  assert.equal(a.status, "imported");
  assert((await command(`cat '${a.sandbox_path}'`)).stdout.includes("东,10"));
  await command(`printf '\n东,1\n' >> '${a.sandbox_path}'`);
  const repeated = await call("import_chat_attachment", {
    attachment_ref: first,
  });
  assert.equal(repeated.reused, true);
  assert.equal(repeated.sandbox_path, a.sandbox_path);
  const b = await call("import_chat_attachment", { attachment_ref: second });
  assert.equal(a.sandboxGeneration, b.sandboxGeneration);
  const analyzed = await command(
    `python -c "import csv,collections; s=collections.Counter(); [s.update({r['地区']:int(r['金额'])}) for f in ['${a.sandbox_path}','${b.sandbox_path}'] for r in csv.DictReader(open(f))]; print(dict(s))"`,
  );
  assert(analyzed.stdout.includes("18") && analyzed.stdout.includes("20"));
  log("two-stage-csv-analysis", { answer: analyzed.stdout });
  assert.equal((await backend.owned()).length, 1);
  assert.deepEqual(await readdir(root), []);
  await attachments.close();
  await pool.sweep();
  assert.equal((await backend.owned()).length, 0);
  log("cleanup", { sandboxes: 0, tempFiles: 0 });
  const checks: Record<
    string,
    { python: (path: string, expanded?: string) => string; expected: string }
  > = {
    xlsx: {
      python: (p) =>
        `import openpyxl; w=openpyxl.load_workbook('${p}',read_only=True); print(sum(r[1] for r in w.active.iter_rows(min_row=2,values_only=True)))`,
      expected: "30",
    },
    pdf: {
      python: (p) =>
        `from pypdf import PdfReader; print(PdfReader('${p}').pages[0].extract_text())`,
      expected: "Fictional PDF amount 30",
    },
    html: {
      python: (p) =>
        `from bs4 import BeautifulSoup; print(BeautifulSoup(open('${p}').read(),'html.parser').h1.get_text())`,
      expected: "Fictional",
    },
    yaml: {
      python: (p) =>
        `import yaml; print(yaml.safe_load(open('${p}'))['amount'])`,
      expected: "30",
    },
    png: {
      python: (p) => `from PIL import Image; print(Image.open('${p}').size)`,
      expected: "(7, 11)",
    },
    zip: {
      python: (_p, e) => `print(open('${e}/example/data.txt').read())`,
      expected: "fictional-archive",
    },
  };
  for (const [kind, file] of Object.entries(fixtureFiles)) {
    plugins = new PluginSession(
      {
        get: async () => plugin,
        trustedHosts: async () => [],
      } as unknown as PluginService,
      [structuredClone(plugin)],
    );
    const attachment = {
      providerAttachmentId: kind,
      fileName: `sample.${kind}`,
      mimeType: file.mimeType,
      sizeBytes: file.data.length,
    };
    attachments = new AttachmentSession(
      {
        config: {
          enabled: true,
          pluginId: plugin.id,
          server: "sandbox",
          limits: attachmentLimitsSchema.parse({}),
        },
        scope: {
          provider: "bluebubbles",
          providerChatId: "fictional-chat",
          triggerMessageId: "current",
        },
        current: { providerMessageId: "current", attachments: [attachment] },
      },
      plugins,
      {
        resolve: async () => ({
          messageId: "current",
          providerMessageId: "current",
          attachment,
          attachmentIndex: 0,
        }),
      },
      downloader,
      store,
    );
    registry = new AgentToolRegistry();
    plugins.register(registry);
    attachments.register(registry);
    const denied = await registry
      .get("import_chat_attachment")!
      .execute(JSON.stringify({ attachment_ref: first }), {
        signal: AbortSignal.timeout(1000),
        deadline: Date.now() + 1000,
        maxOutputCharacters: 64000,
      });
    assert(JSON.stringify(denied).includes("ATTACHMENT_REFERENCE_UNAVAILABLE"));
    const imported = await call("import_chat_attachment", {
      attachment_ref: attachments.currentCatalogue().entries[0]!.attachment_ref,
    });
    const analysis = await command(
      `python -c "${checks[kind]!.python(imported.sandbox_path, imported.expandedPath)}"`,
    );
    assert(analysis.stdout.includes(checks[kind]!.expected));
    log("runtime-format", { kind, answer: analysis.stdout });
    await attachments.close();
    await pool.sweep();
    assert.equal((await backend.owned()).length, 0);
    assert.deepEqual(await readdir(root), []);
  }
} finally {
  await attachments?.close();
  await plugins?.close();
  await probe.close();
  await server.close();
  await pool.sweep();
  for (const id of await backend.owned()) await backend.remove(id);
  await backend.close();
  gateway.closeAllConnections();
  await new Promise<void>((r) => gateway.close(() => r()));
  await rm(root, { recursive: true, force: true });
}
