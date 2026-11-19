import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { PluginService } from "../modules/plugins/plugin-service.js";
import { PluginStorage } from "../modules/plugins/plugin-storage.js";
import { parsePluginPackage } from "../modules/plugins/plugin-package.js";
import { PluginSession } from "../modules/plugins/plugin-session.js";
import { AgentToolRegistry } from "../modules/ai/agent-tool-registry.js";
import { startMockMcp } from "../modules/plugins/mock-mcp.js";
const url = process.env.TEST_DATABASE_URL;
describe.runIf(url)("plugin lifecycle and isolated runtime", () => {
  let root: string,
    service: PluginService,
    mock: Awaited<ReturnType<typeof startMockMcp>>,
    pluginId: string,
    revision: string;
  const name = `fictional-${randomUUID().slice(0, 8)}`;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "plugin-test-"));
    service = new PluginService(
      url ?? "",
      new PluginStorage(root),
      "fictional-encryption-key",
    );
    await service.init();
    mock = await startMockMcp();
  });
  afterAll(async () => {
    if (pluginId) {
      await service.pool.query(
        "DELETE FROM plugin_imports WHERE installed_plugin_id=$1",
        [pluginId],
      );
      await service.pool.query(
        "DELETE FROM plugin_versions WHERE plugin_id=$1",
        [pluginId],
      );
      await service.pool.query("DELETE FROM plugins WHERE id=$1", [pluginId]);
    }
    await mock.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const files = (version = "1.0.0") => ({
    "plugin.json": JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name,
      version,
      description: "Fictional test",
    }),
    "mcp.json": JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { test: { type: "streamable-http", url: mock.url } },
    }),
    "skills/demo/SKILL.md":
      "---\nname: demo\ndescription: fictional lookup\n---\nRead [reference](reference.md).",
    "skills/demo/reference.md": "fictional reference",
  });
  const connection = () => ({
    test: {
      url: mock.url,
      allowPrivate: true,
      auth: "none" as const,
      header: "X-Api-Key",
    },
  });
  async function stage(version = "1.0.0") {
    const pkg = parsePluginPackage(files(version), ".");
    await service.storage.save(pkg);
    const id = randomUUID();
    await service.pool.query(
      "INSERT INTO plugin_imports(id,state,source,directories,package_hash) VALUES($1,'staged','{}','[\".\"]',$2)",
      [id, pkg.hash],
    );
    return id;
  }
  it("installs with explicit tool hash approval and confirms idempotently", async () => {
    const task = await stage();
    const tools = await service.discover(connection());
    const approve = tools.map(
      (t) => `${t.server}/${t.definition.name}#${t.hash}`,
    );
    const p = await service.install(task, ".", connection(), approve);
    pluginId = p.id;
    revision = p.revision;
    expect(p.enabled).toBe(false);
    expect((await service.install(task, ".", connection(), approve)).id).toBe(
      pluginId,
    );
    await service.mutate(pluginId, p.version, { enabled: true });
  });
  it("saves and reloads per-service timeouts without changing tool approval", async () => {
    const p = await service.get(pluginId);
    const connections = {
      test: { ...p.config.connections.test!, callTimeoutSeconds: 150 },
    };
    await service.configure(
      pluginId,
      p.version,
      connections,
      p.config.tools.map((t) => `${t.server}/${t.definition.name}#${t.hash}`),
      [],
      [],
    );
    const saved = await service.get(pluginId);
    expect(saved.config.connections.test!.callTimeoutSeconds).toBe(150);
    expect(saved.config.tools).toEqual(p.config.tools);
    await expect(
      service.configure(pluginId, p.version, connections, [], [], []),
    ).rejects.toMatchObject({ code: "PLUGIN_CONFLICT" });
  });
  it("persists runtime catalogue limits and rejects stale settings writes", async () => {
    const initial = await service.runtimeSettings();
    expect(initial.catalogueCharacters).toBe(64000);
    const saved = await service.updateRuntimeSettings({
      catalogueCharacters: 80000,
      expectedVersion: initial.version,
    });
    try {
      expect((await service.runtimeSettings()).catalogueCharacters).toBe(80000);
      await expect(
        service.updateRuntimeSettings({
          catalogueCharacters: 90000,
          expectedVersion: initial.version,
        }),
      ).rejects.toMatchObject({ code: "PLUGIN_CONFLICT" });
      const usage = await service.runtimeUsage();
      expect(usage.plugins.some((p) => p.id === pluginId)).toBe(true);
      await expect(
        service.assertAvailable([pluginId]),
      ).resolves.toBeUndefined();
    } finally {
      await service.updateRuntimeSettings({
        catalogueCharacters: initial.catalogueCharacters,
        expectedVersion: saved.version,
      });
    }
  });
  it("persists tool review flags without changing administrator version", async () => {
    const before = await service.get(pluginId);
    await service.markToolReview(pluginId, revision, "test/lookup");
    await service.markToolReview(pluginId, revision, "test/lookup");
    const row = (await service.list()).find((p) => p.id === pluginId);
    expect(row?.pending_review).toEqual(["test/lookup"]);
    expect((await service.get(pluginId)).version).toBe(before.version);
  });
  it("summarizes configured abilities and only current active workflow references without exposing credentials", async () => {
    const original = await service.get(pluginId);
    const workflows: string[] = [];
    const tool = original.config.tools[0]!;
    const skill = original.package.skills[0]!;
    try {
      await service.mutate(pluginId, original.version, {
        config: {
          ...original.config,
          disabledTools: [`${tool.server}/${tool.definition.name}`],
          disabledSkills: [skill.id, skill.id],
          autoSyncTools: true,
          connections: {
            test: {
              ...original.config.connections.test!,
              secret: "fictional-private-secret",
            },
          },
        },
      });
      for (const scenario of [
        "active",
        "inactive",
        "deleted",
        "historical",
        "text-only",
      ]) {
        const id = randomUUID(),
          current = randomUUID();
        workflows.push(id);
        await service.pool.query(
          "INSERT INTO workflows(id,name,status,deleted_at) VALUES($1,$2,$3,$4)",
          [
            id,
            `Fictional ${id}`,
            scenario === "inactive" ? "inactive" : "active",
            scenario === "deleted" ? new Date() : null,
          ],
        );
        const node = { type: "ai-chat", config: { pluginIds: [pluginId] } };
        const definition = {
          nodes:
            scenario === "historical" || scenario === "text-only"
              ? [{ type: "ai-chat", config: { promptTemplate: pluginId } }]
              : [node, node],
        };
        await service.pool.query(
          "INSERT INTO workflow_versions(id,workflow_id,version,status,definition) VALUES($1,$2,1,'published',$3)",
          [current, id, JSON.stringify(definition)],
        );
        await service.pool.query(
          "UPDATE workflows SET published_version_id=$2 WHERE id=$1",
          [id, current],
        );
        await service.pool.query(
          "INSERT INTO workflow_versions(id,workflow_id,version,status,definition) VALUES($1,$2,2,'draft',$3)",
          [randomUUID(), id, JSON.stringify({ nodes: [node] })],
        );
      }
      const row = (await service.list()).find((p) => p.id === pluginId)!;
      expect(row.summary).toMatchObject({
        toolsEnabled: original.config.tools.length - 1,
        toolsApproved: original.config.tools.length,
        skillsEnabled: 0,
        skillsTotal: 1,
        servers: 1,
        activeWorkflows: 1,
        autoSyncTools: true,
        lastCheckAt: null,
        lastSyncStatus: null,
      });
      expect(row.metadata.description).toBe("Fictional test");
      expect(row).not.toHaveProperty("encrypted_config");
      expect(row).not.toHaveProperty("config");
      expect(JSON.stringify(row)).not.toContain("fictional-private-secret");
      expect(JSON.stringify(row)).not.toContain(mock.url);
    } finally {
      for (const id of workflows) {
        await service.pool.query(
          "UPDATE workflows SET published_version_id=NULL WHERE id=$1",
          [id],
        );
        await service.pool.query("DELETE FROM workflows WHERE id=$1", [id]);
      }
      const current = await service.get(pluginId);
      await service.mutate(pluginId, current.version, {
        config: original.config,
      });
    }
  });
  it("loads skill and references, executes MCP and enforces authorization", async () => {
    const session = await PluginSession.create(service, [pluginId]);
    try {
      const registry = new AgentToolRegistry();
      session.register(registry);
      const ctx = {
        signal: AbortSignal.timeout(5000),
        deadline: Date.now() + 5000,
        maxOutputCharacters: 20000,
      };
      const load = registry.get("load_plugin_skill")!;
      const skillId = session.catalogue()[0]!.id;
      const result = await load.execute(JSON.stringify({ id: skillId }), ctx);
      expect(typeof result).toBe("object");
      if (typeof result !== "string") {
        await result.validateCommit?.();
        result.commitResult?.();
      }
      expect(
        await registry
          .get("read_plugin_reference")!
          .execute(
            JSON.stringify({ id: `${pluginId}:skills/demo/reference.md` }),
            ctx,
          ),
      ).toMatchObject({
        text: expect.stringContaining("fictional reference") as string,
      });
      expect(await load.execute('{"id":"guessed"}', ctx)).toMatchObject({
        diagnostics: { outcome: "error" },
      });
      const tool = registry
        .definitions()
        .find((t) => t.name.startsWith("ext_"))!;
      expect(
        await registry.get(tool.name)!.execute(
          JSON.stringify({
            query: "library",
          }),
          ctx,
        ),
      ).toMatchObject({ diagnostics: { outcome: "success" } });
      const p = await service.get(pluginId);
      await service.mutate(pluginId, p.version, { enabled: false });
      expect(
        await registry.get(tool.name)!.execute(
          JSON.stringify({
            query: "library",
          }),
          ctx,
        ),
      ).toMatchObject({
        diagnostics: {
          outcome: "error",
          errorCode: "PLUGIN_PERMISSION_REVOKED",
        },
      });
      await service.mutate(pluginId, p.version + 1, { enabled: true });
    } finally {
      await session.close();
    }
  });
  it("does not authorize reference reads when skill result exceeds the budget", async () => {
    const s = await PluginSession.create(service, [pluginId]);
    try {
      const registry = new AgentToolRegistry();
      s.register(registry);
      const ctx = {
        signal: AbortSignal.timeout(5000),
        deadline: Date.now() + 5000,
        maxOutputCharacters: 1,
      };
      expect(
        await registry
          .get("load_plugin_skill")!
          .execute(JSON.stringify({ id: s.catalogue()[0]!.id }), ctx),
      ).toMatchObject({ diagnostics: { outcome: "error" } });
      expect(
        await registry
          .get("read_plugin_reference")!
          .execute(
            JSON.stringify({ id: `${pluginId}:skills/demo/reference.md` }),
            { ...ctx, maxOutputCharacters: 10000 },
          ),
      ).toMatchObject({ diagnostics: { outcome: "error" } });
    } finally {
      await s.close();
    }
  });
  it("checks management versions and keeps active package on failed upgrades", async () => {
    const p = await service.get(pluginId);
    await expect(
      service.mutate(pluginId, p.version - 1, { enabled: false }),
    ).rejects.toThrow();
    const task = await stage("2.0.0");
    await expect(
      service.install(
        task,
        ".",
        connection(),
        ["test/lookup#wrong"],
        p.version,
      ),
    ).rejects.toThrow();
    expect((await service.get(pluginId)).revision).toBe(revision);
    const tools = await service.discover(connection());
    await service.install(
      task,
      ".",
      connection(),
      tools.map((t) => `${t.server}/${t.definition.name}#${t.hash}`),
      p.version,
    );
    const next = await service.get(pluginId);
    expect(next.package.version).toBe("2.0.0");
    await service.mutate(pluginId, next.version, { revision });
    expect((await service.get(pluginId)).package.version).toBe("1.0.0");
  });
  it("survives storage relocation and rejects corrupt files", async () => {
    const moved = await mkdtemp(join(tmpdir(), "plugin-restored-"));
    try {
      await cp(root, moved, { recursive: true });
      const storage = new PluginStorage(moved);
      expect((await storage.read(revision)).hash).toBe(revision);
      const path = join(moved, revision);
      const pkg = JSON.parse(await readFile(path, "utf8")) as {
        files: Record<string, string>;
      };
      pkg.files["skills/demo/reference.md"] = "changed";
      await writeFile(path, JSON.stringify(pkg));
      await expect(storage.read(revision)).rejects.toThrow();
    } finally {
      await rm(moved, { recursive: true, force: true });
    }
  });
});
