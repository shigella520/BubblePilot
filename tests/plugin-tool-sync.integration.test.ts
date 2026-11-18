import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { PluginService } from "../modules/plugins/plugin-service.js";
import { PluginStorage } from "../modules/plugins/plugin-storage.js";
import {
  parsePluginPackage,
  digest,
} from "../modules/plugins/plugin-package.js";
import { startMockMcp } from "../modules/plugins/mock-mcp.js";
import { PluginMcp } from "../modules/plugins/plugin-mcp.js";
import { PluginSession } from "../modules/plugins/plugin-session.js";
import { AgentToolRegistry } from "../modules/ai/agent-tool-registry.js";
import type { ApprovedTool } from "../modules/plugins/plugin-types.js";
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.runIf(databaseUrl)("automatic approved tool synchronization", () => {
  let service: PluginService,
    root: string,
    mock: Awaited<ReturnType<typeof startMockMcp>>;
  const databaseName = `bp_plugin_sync_${randomUUID().replaceAll("-", "")}_test`;
  let admin: Client;
  let discoverMock = vi.fn<PluginService["discover"]>();
  let id: string, original: ApprovedTool[], next: ApprovedTool[];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "plugin-sync-"));
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const address = new URL(databaseUrl!);
    address.pathname = `/${databaseName}`;
    const db = new Client({ connectionString: address.href });
    await db.connect();
    try {
      for (const file of (
        await readdir(new URL("../migrations/", import.meta.url))
      )
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        await db.query(
          await readFile(
            new URL(`../migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
      }
    } finally {
      await db.end();
    }
    service = new PluginService(
      address.href,
      new PluginStorage(root),
      "fictional-sync-key",
    );
    await service.storage.init();
    mock = await startMockMcp();
  }, 30000);
  afterAll(async () => {
    await service?.close();
    await mock?.close();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
    await rm(root, { force: true, recursive: true });
  });
  beforeEach(async () => {
    id = randomUUID();
    const connections = {
      test: {
        url: mock.url,
        allowPrivate: true,
        auth: "none" as const,
        header: "X-Api-Key",
      },
    };
    original = await service.discover(connections);
    original[0]!.definition.parameters = {
      ...original[0]!.definition.parameters,
      additionalProperties: false,
    };
    original[0]!.hash = digest(original[0]!.definition);
    next = structuredClone(original);
    const pkg = parsePluginPackage(
      {
        "plugin.json": JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: `fixture-sync-${id}`,
          version: "1.0.0",
          description: "Fictional sync test",
        }),
        "mcp.json": JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: { test: { type: "streamable-http", url: mock.url } },
        }),
      },
      ".",
    );
    await service.storage.save(pkg);
    await service.pool.query(
      "INSERT INTO plugins(id,name,enabled,revision) VALUES($1,$2,true,$3)",
      [id, pkg.name, pkg.hash],
    );
    await service.pool.query(
      "INSERT INTO plugin_versions(plugin_id,hash,package_version,source,metadata,encrypted_config) VALUES($1,$2,'1.0.0','{}','{}',$3)",
      [
        id,
        pkg.hash,
        service.cipher.encrypt(
          JSON.stringify({
            connections,
            tools: original,
            disabledTools: [],
            disabledSkills: [],
            autoSyncTools: true,
          }),
        ),
      ],
    );
    discoverMock = vi
      .fn<PluginService["discover"]>()
      .mockImplementation(() => Promise.resolve(next));
    vi.spyOn(service, "discover").mockImplementation(discoverMock);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await service.pool.query("DELETE FROM audit_events WHERE target_id=$1", [
      id,
    ]);
    await service.pool.query("DELETE FROM plugin_versions WHERE plugin_id=$1", [
      id,
    ]);
    await service.pool.query("DELETE FROM plugins WHERE id=$1", [id]);
  });
  function optional() {
    const t = next[0]!;
    (t.definition.parameters.properties as Record<string, unknown>).limit = {
      type: "integer",
    };
    t.hash = digest(t.definition);
  }
  async function run(session: PluginSession) {
    const registry = new AgentToolRegistry();
    session.register(registry);
    const name = registry
      .definitions()
      .find((t) => t.name.startsWith("ext_"))!.name;
    return registry.get(name)!.execute(
      JSON.stringify({
        query: "library",
      }),
      {
        signal: AbortSignal.timeout(5000),
        deadline: Date.now() + 5000,
        maxOutputCharacters: 10000,
      },
    );
  }
  it("preserves scope and connections, updates atomically, and records metadata/audit", async () => {
    const old = await service.get(id);
    optional();
    next.push({
      ...next[0]!,
      definition: { ...next[0]!.definition, name: "unapproved" },
    });
    await service.syncTools(id, "scheduled");
    const saved = await service.get(id);
    expect(saved.version).toBe(old.version + 1);
    expect(saved.config.connections).toEqual(old.config.connections);
    expect(saved.config.tools).toHaveLength(1);
    expect(saved.config.tools[0]!.hash).toBe(next[0]!.hash);
    expect(saved.toolSyncHistory?.[0]).toMatchObject({
      status: "updated",
      source: "scheduled",
    });
    expect(
      (
        await service.pool.query<{ metadata: Record<string, unknown> }>(
          "SELECT metadata FROM audit_events WHERE target_id=$1",
          [id],
        )
      ).rows[0]?.metadata,
    ).toMatchObject({ status: "updated", changedTools: 1 });
  });
  it("defaults legacy settings off and skips disabled plugins", async () => {
    const p = await service.get(id);
    delete p.config.autoSyncTools;
    await service.mutate(id, p.version, { config: p.config });
    optional();
    await service.syncTools(id, "scheduled");
    expect(discoverMock).not.toHaveBeenCalled();
    expect((await service.get(id)).config.tools).toEqual(original);
    const fresh = await service.get(id);
    await service.mutate(id, fresh.version, {
      enabled: false,
      config: { ...fresh.config, autoSyncTools: true },
    });
    await service.syncTools(id, "scheduled");
    expect(discoverMock).not.toHaveBeenCalled();
  });
  it("marks incompatible changes, deduplicates audit and preserves approved definition", async () => {
    next[0]!.definition.description = "Different operation";
    next[0]!.hash = "changed";
    await service.syncTools(id, "call");
    await service.syncTools(id, "call");
    const p = await service.get(id);
    expect(p.pendingReview).toEqual(["test/lookup"]);
    expect(p.config.tools).toEqual(original);
    expect(p.toolSyncHistory).toHaveLength(1);
    expect(
      (
        await service.pool.query<{ count: string }>(
          "SELECT count(*) FROM audit_events WHERE target_id=$1",
          [id],
        )
      ).rows[0]?.count,
    ).toBe("1");
  });
  it("records discovery failure without replacing approval or leaking transport details", async () => {
    discoverMock.mockRejectedValue(new Error("fictional-secret-do-not-log"));
    await service.syncTools(id, "scheduled");
    const p = await service.get(id);
    expect(p.config.tools).toEqual(original);
    expect(p.toolSyncHistory?.[0]?.status).toBe("failed");
    expect(JSON.stringify(p.toolSyncHistory)).not.toContain("fictional-secret");
  });
  it("does not overwrite a concurrent administrator change", async () => {
    optional();
    discoverMock.mockImplementation(async () => {
      const p = await service.get(id);
      await service.mutate(id, p.version, { enabled: false });
      return next;
    });
    await service.syncTools(id, "scheduled");
    const p = await service.get(id);
    expect(p.enabled).toBe(false);
    expect(p.config.tools).toEqual(original);
    expect(p.toolSyncHistory).toEqual([]);
  });
  it("uses a database lock to prevent overlapping discoveries", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const entered = new Promise<void>((r) => {
      started = r;
    });
    discoverMock.mockImplementation(async () => {
      started();
      await gate;
      return next;
    });
    const first = service.syncTools(id, "scheduled");
    await entered;
    try {
      await service.syncTools(id, "scheduled");
      expect(discoverMock).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await first;
    }
  });
  it("preserves in-flight schemas across a compatible synchronization and honors revocation", async () => {
    const session = await PluginSession.create(service, [id]);
    optional();
    vi.spyOn(PluginMcp.prototype, "discover").mockImplementation(() =>
      Promise.resolve(next),
    );
    try {
      expect(await run(session)).toMatchObject({
        diagnostics: { outcome: "success" },
      });
      expect((await service.get(id)).config.tools[0]!.hash).toBe(next[0]!.hash);
      expect(await run(session)).toMatchObject({
        diagnostics: { outcome: "success" },
      });
      const p = await service.get(id);
      await service.mutate(id, p.version, { enabled: false });
      expect(await run(session)).toMatchObject({
        diagnostics: { errorCode: "PLUGIN_PERMISSION_REVOKED" },
      });
    } finally {
      await session.close();
    }
  });
  it("accepts harmless formatting on legacy approvals without enabling automatic changes", async () => {
    const p = await service.get(id);
    delete p.config.autoSyncTools;
    await service.mutate(id, p.version, { config: p.config });
    const session = await PluginSession.create(service, [id]);
    next[0]!.definition.description =
      "\n" + next[0]!.definition.description + "\n";
    next[0]!.hash = "format";
    vi.spyOn(PluginMcp.prototype, "discover").mockImplementation(() =>
      Promise.resolve(next),
    );
    try {
      expect(await run(session)).toMatchObject({
        diagnostics: { outcome: "success" },
      });
    } finally {
      await session.close();
    }
  });
  it("does not repeatedly contact an incompatible tool within one run", async () => {
    const session = await PluginSession.create(service, [id]);
    next[0]!.definition.description = "Changed behavior";
    next[0]!.hash = "changed";
    const discover = vi
      .spyOn(PluginMcp.prototype, "discover")
      .mockImplementation(() => Promise.resolve(next));
    try {
      expect(await run(session)).toMatchObject({
        diagnostics: { errorCode: "PLUGIN_TOOL_REVIEW_REQUIRED" },
      });
      expect(await run(session)).toMatchObject({
        diagnostics: { errorCode: "PLUGIN_TOOL_REVIEW_REQUIRED" },
      });
      expect(discover).toHaveBeenCalledTimes(1);
    } finally {
      await session.close();
    }
  });
  it("omits known incompatible tools from new runs and restores them after compatibility returns", async () => {
    next[0]!.definition.description = "Changed behavior";
    next[0]!.hash = "changed";
    await service.syncTools(id, "scheduled");
    const blocked = await PluginSession.create(service, [id]);
    try {
      const registry = new AgentToolRegistry();
      blocked.register(registry);
      expect(
        registry.definitions().some((t) => t.name.startsWith("ext_")),
      ).toBe(false);
    } finally {
      await blocked.close();
    }
    next = structuredClone(original);
    await service.syncTools(id, "call");
    expect((await service.get(id)).pendingReview).toEqual([]);
    const restored = await PluginSession.create(service, [id]);
    try {
      const registry = new AgentToolRegistry();
      restored.register(registry);
      expect(
        registry.definitions().some((t) => t.name.startsWith("ext_")),
      ).toBe(true);
    } finally {
      await restored.close();
    }
  });
  it("does not discover or update disabled tools", async () => {
    const p = await service.get(id);
    await service.mutate(id, p.version, {
      config: { ...p.config, disabledTools: ["test/lookup"] },
    });
    optional();
    await service.syncTools(id, "scheduled");
    expect(discoverMock).not.toHaveBeenCalled();
    expect((await service.get(id)).config.tools).toEqual(original);
  });
  it("checks due plugins once and saves the last check even without changes", async () => {
    await service.syncDueTools();
    const p = await service.get(id);
    expect(p.toolSyncLastCheck).toBeTruthy();
    const count = discoverMock.mock.calls.length;
    await service.syncDueTools();
    expect(discoverMock).toHaveBeenCalledTimes(count);
  });
});
