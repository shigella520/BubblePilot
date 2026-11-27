import type { ToolSyncRecord } from "./plugin-tool-sync.js";
import {
  PluginToolSynchronizer,
  type ToolObservation,
} from "./plugin-tool-synchronizer.js";
import type { AttachmentHandling } from "../attachments/attachment-policy.js";
import {
  attachmentTargets,
  assertAttachmentBinding,
  findAttachmentTarget,
} from "./plugin-attachments.js";
import { requiredTransportTools } from "./plugin-transport.js";
import { toolContractHash } from "./plugin-tool-sync.js";
import { ApplicationError } from "../../app/errors.js";
import { pluginCatalogueUsage } from "./plugin-catalogue.js";
import type { TrustedHostsProvider } from "../shared/network-settings.js";
import { pluginImportErrorCode } from "./plugin-import-error.js";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { SettingsCipher } from "../integrations/bluebubbles/settings-cipher.js";
import type { PluginStorage } from "./plugin-storage.js";
import { importGit, unpackZip } from "./plugin-storage.js";
import { packageDirectories, parsePluginPackage } from "./plugin-package.js";
import { PluginMcp } from "./plugin-mcp.js";
import {
  pluginError,
  pluginLimits,
  type PluginPackage,
  type PluginConfiguration,
  type InstalledPlugin,
  type Connection,
} from "./plugin-types.js";
interface PluginListRow {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  revision: string;
  created_at: Date;
  updated_at: Date;
  package_version: string;
  source: Record<string, unknown>;
  metadata: {
    description: string;
    skills: number;
    servers: number;
    toolSyncLastCheck?: string;
    toolSyncHistory?: ToolSyncRecord[];
  };
  pending_review: string[] | null;
  encrypted_config: string;
  active_workflow_count: number;
}
export class PluginService {
  readonly pool: Pool;
  private readonly jobs = new Set<Promise<void>>();
  readonly cipher: SettingsCipher;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  constructor(
    databaseUrl: string,
    readonly storage: PluginStorage,
    key: string,
    readonly trustedHosts: TrustedHostsProvider = () => Promise.resolve([]),
  ) {
    this.pool = new Pool({ connectionString: databaseUrl });
    this.cipher = new SettingsCipher(key);
  }
  private syncTimer: ReturnType<typeof setInterval> | undefined;
  private syncJob: Promise<void> | undefined;
  async syncTools(
    id: string,
    source: "scheduled" | "call",
    observation?: ToolObservation,
  ) {
    return new PluginToolSynchronizer(this).check(id, source, observation);
  }
  async syncDueTools() {
    if (this.syncJob) return this.syncJob;
    this.syncJob = (async () => {
      const rows = await this.pool.query<{ id: string }>(
        `SELECT p.id FROM plugins p JOIN plugin_versions v ON v.plugin_id=p.id AND v.hash=p.revision WHERE p.enabled AND (v.metadata->>'toolSyncLastCheck' IS NULL OR (v.metadata->>'toolSyncLastCheck')::timestamptz < now()-interval '1 hour')`,
      );
      for (const row of rows.rows)
        await this.syncTools(row.id, "scheduled").catch(() => undefined);
    })();
    try {
      await this.syncJob;
    } finally {
      this.syncJob = undefined;
    }
  }
  async init() {
    await this.storage.init();
    await this.storage.cleanup();
    await this.pool.query(
      "UPDATE plugin_imports SET state='failed',error_code='INTERRUPTED' WHERE state='loading'",
    );
    await this.collect();
    this.cleanupTimer = setInterval(() => {
      void this.collect().catch(() => undefined);
    }, 3600000);
    this.cleanupTimer.unref();
    this.syncTimer = setInterval(() => {
      void this.syncDueTools().catch(() => undefined);
    }, 60_000);
    this.syncTimer.unref();
  }
  async collect() {
    const rows = await this.pool.query<{ hash: string }>(
      "SELECT hash FROM plugin_versions UNION SELECT package_hash AS hash FROM plugin_imports WHERE package_hash IS NOT NULL AND created_at > now()-interval '24 hours'",
    );
    await this.storage.collect(new Set(rows.rows.map((r) => r.hash)));
    await this.storage.cleanup();
  }
  async close() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    await this.syncJob;
    await Promise.allSettled([...this.jobs]);
    await this.pool.end();
  }
  async stage(source: Record<string, unknown>, bytes?: Buffer) {
    if (this.jobs.size >= 4) pluginError("IMPORT_BUSY", 429);
    const id = randomUUID();
    await this.pool.query(
      "INSERT INTO plugin_imports(id,state,source) VALUES($1,'loading',$2)",
      [id, source],
    );
    const job = (async () => {
      try {
        const data = bytes
          ? { files: await unpackZip(bytes), sha: null }
          : await importGit(
              this.storage.root,
              String(source.url),
              typeof source.ref === "string" ? source.ref : undefined,
              await this.trustedHosts(),
              typeof source.directory === "string"
                ? source.directory
                : undefined,
            );
        const directories = packageDirectories(data.files);
        if (!directories.length) pluginError("NO_PLUGIN_MANIFEST");
        const pkg: PluginPackage = {
          name: "staging",
          version: "0.0.0",
          description: "staging",
          format: "codex",
          skills: [],
          servers: [],
          files: data.files,
          hash: "",
        };
        const { digest } = await import("./plugin-package.js");
        pkg.hash = digest(
          Object.entries(pkg.files).sort(([a], [b]) => a.localeCompare(b)),
        );
        await this.storage.save(pkg);
        await this.pool.query(
          "UPDATE plugin_imports SET state='staged',directories=$2,package_hash=$3,source=$4 WHERE id=$1",
          [
            id,
            JSON.stringify(directories),
            pkg.hash,
            {
              ...source,
              ...("resolvedSource" in data ? data.resolvedSource : {}),
              sha: data.sha,
            },
          ],
        );
      } catch (error) {
        await this.pool.query(
          "UPDATE plugin_imports SET state='failed',error_code=$2 WHERE id=$1",
          [id, pluginImportErrorCode(error)],
        );
      }
    })();
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => undefined);
    return this.importView(id);
  }
  async importView(id: string) {
    const r = await this.pool.query(
      "SELECT id,state,source,directories,package_hash,error_code,installed_plugin_id FROM plugin_imports WHERE id=$1",
      [id],
    );
    if (!r.rows[0]) pluginError("IMPORT_NOT_FOUND", 404);
    return r.rows[0] as Record<string, unknown>;
  }
  async inspect(id: string, directory: string) {
    const task = await this.importView(id);
    if (!task?.package_hash) pluginError("IMPORT_NOT_READY", 409);
    const staged = await this.storage.read(task.package_hash as string);
    return parsePluginPackage(staged.files, directory);
  }
  async list() {
    const r = await this.pool.query<PluginListRow>(
      `SELECT p.*,v.package_version,v.metadata,v.source,v.encrypted_config,
        v.metadata->'pendingReview' AS pending_review,
        (SELECT count(*)::int FROM workflows w
         JOIN workflow_versions wv ON wv.id=w.published_version_id
         WHERE w.status='active' AND w.deleted_at IS NULL AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(wv.definition->'nodes') node
           WHERE node->>'type'='ai-chat'
             AND (node->'config'->'pluginIds') @> jsonb_build_array(p.id::text)
         )) AS active_workflow_count
       FROM plugins p JOIN plugin_versions v ON v.plugin_id=p.id AND v.hash=p.revision
       ORDER BY p.name`,
    );
    return r.rows.map((row) => {
      // Only computed counts leave the server; never return decrypted connections
      // or the encrypted configuration in the list response.
      const { encrypted_config, active_workflow_count, ...item } = row;
      const config = JSON.parse(
        this.cipher.decrypt(encrypted_config),
      ) as PluginConfiguration;
      const metadata = item.metadata;
      return {
        ...item,
        summary: {
          toolsEnabled: config.tools.filter(
            (tool) =>
              !config.disabledTools.includes(
                `${tool.server}/${tool.definition.name}`,
              ),
          ).length,
          toolsApproved: config.tools.length,
          skillsEnabled: Math.max(
            0,
            metadata.skills - new Set(config.disabledSkills).size,
          ),
          skillsTotal: metadata.skills,
          servers: metadata.servers,
          activeWorkflows: active_workflow_count,
          autoSyncTools: config.autoSyncTools ?? false,
          lastCheckAt: metadata.toolSyncLastCheck ?? null,
          lastSyncStatus: metadata.toolSyncHistory?.[0]?.status ?? null,
        },
      };
    });
  }
  async get(id: string, revision?: string): Promise<InstalledPlugin> {
    const r = await this.pool.query(
      "SELECT p.*,v.encrypted_config,v.hash,v.metadata FROM plugins p JOIN plugin_versions v ON v.plugin_id=p.id AND v.hash=COALESCE($2,p.revision) WHERE p.id=$1",
      [id, revision ?? null],
    );
    const p = r.rows[0] as
      | {
          id: string;
          name: string;
          enabled: boolean;
          version: number;
          revision: string;
          hash: string;
          encrypted_config: string;
          metadata: {
            pendingReview?: string[];
            toolSyncHistory?: ToolSyncRecord[];
            toolSyncLastCheck?: string;
          };
        }
      | undefined;
    if (!p) pluginError("NOT_FOUND", 404);
    return {
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      version: p.version,
      revision: p.hash,
      package: parsePluginPackage((await this.storage.read(p.hash)).files, "."),
      pendingReview: p.metadata.pendingReview ?? [],
      toolSyncHistory: p.metadata.toolSyncHistory ?? [],
      toolSyncLastCheck: p.metadata.toolSyncLastCheck ?? null,
      config: JSON.parse(
        this.cipher.decrypt(p.encrypted_config),
      ) as PluginConfiguration,
    };
  }
  async detail(id: string) {
    const p = await this.get(id);
    const versions = await this.pool.query(
      "SELECT hash,package_version,source,created_at FROM plugin_versions WHERE plugin_id=$1 ORDER BY created_at DESC",
      [id],
    );
    return {
      ...p,
      package: { ...p.package, files: undefined },
      config: {
        ...p.config,
        connections: Object.fromEntries(
          Object.entries(p.config.connections).map(([k, c]) => [
            k,
            { ...c, secret: undefined, secretConfigured: !!c.secret },
          ]),
        ),
      },
      versions: versions.rows as Record<string, unknown>[],
      references: (
        await this.pool.query(
          "SELECT workflow_id,version FROM workflow_versions WHERE definition::text LIKE $1",
          [`%${id}%`],
        )
      ).rows as { workflow_id: string; version: number }[],
    };
  }
  async markToolReview(
    id: string,
    revision: string,
    tool: string,
    expectedVersion?: number,
  ) {
    await this.pool.query(
      `UPDATE plugin_versions SET metadata=jsonb_set(metadata,'{pendingReview}',
        COALESCE(metadata->'pendingReview','[]'::jsonb) || to_jsonb($3::text))
       WHERE plugin_id=$1 AND hash=$2 AND NOT COALESCE(metadata->'pendingReview','[]'::jsonb) ? $3
       AND ($4::integer IS NULL OR EXISTS(SELECT 1 FROM plugins WHERE id=$1 AND version=$4 AND revision=$2))`,
      [id, revision, tool, expectedVersion ?? null],
    );
  }
  async discover(connections: Record<string, Connection>) {
    const tools: PluginConfiguration["tools"] = [];
    for (const [server, c] of Object.entries(connections)) {
      const client = new PluginMcp(this.trustedHosts);
      try {
        await client.connect(c);
        tools.push(...(await client.discover(server)));
      } finally {
        await client.close();
      }
    }
    return tools;
  }
  async install(
    taskId: string,
    directory: string,
    connections: Record<string, Connection>,
    approved: string[],
    expectedVersion?: number,
  ) {
    const task = await this.importView(taskId);
    if (task?.installed_plugin_id)
      return this.detail(task.installed_plugin_id as string);
    const pkg = await this.inspect(taskId, directory);
    this.checkConnections(pkg, connections);
    const discovered = await this.discover(connections);
    const tools = discovered.filter((t) =>
      approved.includes(`${t.server}/${t.definition.name}#${t.hash}`),
    );
    if (
      approved.some(
        (a) =>
          !tools.some(
            (t) => `${t.server}/${t.definition.name}#${t.hash}` === a,
          ),
      )
    )
      pluginError("TOOL_CHANGED", 409);
    const config: PluginConfiguration = {
      connections,
      tools,
      disabledSkills: [],
      disabledTools: [],
    };
    await this.storage.save(pkg);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        pkg.name,
      ]);
      const installed = (
        await client.query(
          "SELECT installed_plugin_id FROM plugin_imports WHERE id=$1 FOR UPDATE",
          [taskId],
        )
      ).rows[0] as { installed_plugin_id: string | null } | undefined;
      if (installed?.installed_plugin_id) {
        await client.query("COMMIT");
        return this.detail(installed.installed_plugin_id);
      }
      const old = (
        await client.query("SELECT * FROM plugins WHERE name=$1 FOR UPDATE", [
          pkg.name,
        ])
      ).rows[0] as { id: string; version: number } | undefined;
      if (old && old.version !== expectedVersion) pluginError("CONFLICT", 409);
      const id = old?.id ?? randomUUID();
      const existing = (
        await client.query(
          "SELECT hash FROM plugin_versions WHERE plugin_id=$1 AND package_version=$2",
          [id, pkg.version],
        )
      ).rows[0] as { hash: string } | undefined;
      if (existing && existing.hash !== pkg.hash)
        pluginError("VERSION_CONTENT_CONFLICT", 409);
      if (existing) {
        await client.query(
          "UPDATE plugin_imports SET state='installed',installed_plugin_id=$2 WHERE id=$1",
          [taskId, id],
        );
        await client.query("COMMIT");
        return this.detail(id);
      }
      if (!old)
        await client.query(
          "INSERT INTO plugins(id,name,revision) VALUES($1,$2,$3)",
          [id, pkg.name, pkg.hash],
        );
      await client.query(
        "INSERT INTO plugin_versions(plugin_id,hash,package_version,source,metadata,encrypted_config) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [
          id,
          pkg.hash,
          pkg.version,
          task?.source ?? {},
          {
            description: pkg.description,
            skills: pkg.skills.length,
            servers: pkg.servers.length,
          },
          this.cipher.encrypt(JSON.stringify(config)),
        ],
      );
      if (old)
        await client.query(
          "UPDATE plugins SET revision=$2,version=version+1,updated_at=now() WHERE id=$1",
          [id, pkg.hash],
        );
      await client.query(
        "UPDATE plugin_imports SET state='installed',installed_plugin_id=$2 WHERE id=$1",
        [taskId, id],
      );
      await client.query("COMMIT");
      return this.detail(id);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  checkConnections(pkg: PluginPackage, c: Record<string, Connection>) {
    if (
      pkg.servers.some((s) => !c[s.name]) ||
      Object.keys(c).some((n) => !pkg.servers.some((s) => s.name === n))
    )
      pluginError("CONNECTIONS_REQUIRED");
  }
  async mutate(
    id: string,
    expectedVersion: number,
    input: {
      enabled?: boolean;
      revision?: string;
      config?: PluginConfiguration;
    },
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (
        await client.query(
          "SELECT version,revision FROM plugins WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0] as { version: number; revision: string } | undefined;
      if (!row || row.version !== expectedVersion) pluginError("CONFLICT", 409);
      if (input.revision) await this.get(id, input.revision);
      if (input.config)
        await client.query(
          "UPDATE plugin_versions SET encrypted_config=$3,metadata=metadata-'pendingReview' WHERE plugin_id=$1 AND hash=$2",
          [id, row.revision, this.cipher.encrypt(JSON.stringify(input.config))],
        );
      await client.query(
        "UPDATE plugins SET enabled=COALESCE($3,enabled),revision=COALESCE($4,revision),version=version+1,updated_at=now() WHERE id=$1 AND version=$2",
        [id, expectedVersion, input.enabled ?? null, input.revision ?? null],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return this.detail(id);
  }
  async configure(
    id: string,
    expectedVersion: number,
    connections: Record<string, Connection>,
    approved: string[],
    disabledSkills: string[],
    disabledTools: string[],
    autoSyncTools?: boolean,
  ) {
    const p = await this.get(id);
    for (const [name, c] of Object.entries(connections))
      if (
        c.secret === undefined &&
        p.config.connections[name]?.url === c.url &&
        p.config.connections[name]?.auth === c.auth &&
        p.config.connections[name]?.header === c.header
      )
        c.secret = p.config.connections[name]?.secret;
    this.checkConnections(p.package, connections);
    if (disabledSkills.some((s) => !p.package.skills.some((k) => k.id === s)))
      pluginError("UNKNOWN_SKILL");
    const discovered = await this.discover(connections);
    const tools = discovered.filter((t) =>
      approved.includes(`${t.server}/${t.definition.name}#${t.hash}`),
    );
    if (approved.length !== tools.length) pluginError("TOOL_CHANGED", 409);
    return this.mutate(id, expectedVersion, {
      config: {
        connections,
        tools,
        disabledSkills,
        disabledTools,
        autoSyncTools: autoSyncTools ?? p.config.autoSyncTools ?? false,
      },
    });
  }
  async runtimeSettings() {
    const result = await this.pool.query<{
      catalogue_characters: number;
      version: number;
      updated_at: Date;
    }>("SELECT * FROM plugin_runtime_settings WHERE id=1");
    const row = result.rows[0];
    if (!row) pluginError("SETTINGS_UNAVAILABLE", 503);
    return {
      catalogueCharacters: row.catalogue_characters,
      version: row.version,
      updatedAt: row.updated_at.toISOString(),
    };
  }
  async updateRuntimeSettings(input: {
    catalogueCharacters: number;
    expectedVersion: number;
  }) {
    const result = await this.pool.query<{
      catalogue_characters: number;
      version: number;
      updated_at: Date;
    }>(
      "UPDATE plugin_runtime_settings SET catalogue_characters=$1,version=version+1,updated_at=now() WHERE id=1 AND version=$2 RETURNING *",
      [input.catalogueCharacters, input.expectedVersion],
    );
    const row = result.rows[0];
    if (!row) pluginError("CONFLICT", 409);
    return {
      catalogueCharacters: row.catalogue_characters,
      version: row.version,
      updatedAt: row.updated_at.toISOString(),
    };
  }
  async runtimeUsage() {
    const rows = await this.pool.query<{ id: string }>(
      "SELECT id FROM plugins WHERE enabled=true ORDER BY name,id",
    );
    return pluginCatalogueUsage(
      this,
      await Promise.all(rows.rows.map((row) => this.get(row.id))),
    );
  }
  async attachmentTargets() {
    const rows = await this.pool.query<{ id: string }>(
      "SELECT id FROM plugins WHERE enabled=true ORDER BY name,id",
    );
    return attachmentTargets(
      await Promise.all(rows.rows.map((r) => this.get(r.id))),
    );
  }
  async imageExportTargets() {
    const rows = await this.pool.query<{ id: string }>(
      "SELECT id FROM plugins WHERE enabled=true ORDER BY name,id",
    );
    return imageExportTargets(
      await Promise.all(rows.rows.map((r) => this.get(r.id))),
    );
  }
  async assertImageExportAvailable(ids: string[], config: ImageReply) {
    const plugins = await Promise.all(ids.map((id) => this.get(id)));
    assertImageExportBinding(plugins, config);
    const p = plugins.find((p) => p.id === config.pluginId)!;
    const client = new PluginMcp(this.trustedHosts);
    try {
      await client.connect(p.config.connections[config.server]!);
      if (
        needsFileExport(config)
          ? client.fileExportVersion() !== 1
          : client.imageExportVersion() !== 1 &&
            client.fileExportVersion() !== 1
      )
        pluginError("IMAGE_EXPORT_UNSUPPORTED");
    } finally {
      await client.close();
    }
  }
  async assertAttachmentAvailable(ids: string[], config: AttachmentHandling) {
    const plugins = await Promise.all(ids.map((id) => this.get(id)));
    assertAttachmentBinding(plugins, config);
    const plugin = plugins.find((p) => p.id === config.pluginId)!;
    const client = new PluginMcp(this.trustedHosts);
    try {
      await client.connect(plugin.config.connections[config.server]!);
      if (client.attachmentVersion() !== 1)
        pluginError("ATTACHMENT_TARGET_UPGRADE_REQUIRED", 409);
      await this.assertTransportToolsUnchanged(
        client,
        plugin,
        config.server,
        "prepare_sandbox",
        "attachment",
        "ATTACHMENT_TOOL_REVIEW_REQUIRED",
      );
    } finally {
      await client.close();
    }
  }
  /** A generator target must offer both chat-image import and PNG export. */
  async assertImageGenerationAvailable(
    ids: string[],
    binding: { pluginId: string; server: string },
  ) {
    const plugins = await Promise.all(ids.map((id) => this.get(id)));
    const attachment = findAttachmentTarget(plugins, binding, "generator");
    const exported = findImageExportTarget(plugins, binding, "generator", [
      "png",
    ]);
    if (
      attachment.anchorTool !== exported.anchorTool ||
      attachment.workspacePrefix !== exported.workspacePrefix
    )
      pluginError("TRANSPORT_CAPABILITY_INVALID", 409);
    const plugin = plugins.find((p) => p.id === binding.pluginId)!;
    const client = new PluginMcp(this.trustedHosts);
    try {
      await client.connect(plugin.config.connections[binding.server]!);
      if (client.attachmentVersion() !== 1 || client.imageExportVersion() !== 1)
        pluginError("IMAGE_GENERATION_TARGET_UPGRADE_REQUIRED", 409);
      await this.assertTransportToolsUnchanged(
        client,
        plugin,
        binding.server,
        attachment.anchorTool,
        "attachment",
        "IMAGE_GENERATION_TOOL_REVIEW_REQUIRED",
      );
    } finally {
      await client.close();
    }
  }
  private async assertTransportToolsUnchanged(
    client: PluginMcp,
    plugin: InstalledPlugin,
    server: string,
    anchorTool: string,
    purpose: "export" | "attachment",
    code: string,
  ) {
    const anchor = plugin.config.tools.find(
      (t) => t.server === server && t.definition.name === anchorTool,
    );
    if (!anchor) pluginError(code, 409);
    const live = await client.discover(server);
    for (const name of requiredTransportTools(anchor, purpose)) {
      const approved = plugin.config.tools.find(
        (t) => t.server === server && t.definition.name === name,
      );
      const current = live.find((t) => t.definition.name === name);
      if (
        !approved ||
        !current ||
        current.hash !== approved.hash ||
        toolContractHash(current) !== toolContractHash(approved)
      )
        pluginError(code, 409);
    }
  }
  async assertAvailable(ids: string[]) {
    if (!ids.length) return;
    const plugins = await Promise.all(
      [...new Set(ids)].map((id) => this.get(id)),
    );
    for (const p of plugins) {
      if (!p.enabled) pluginError("DISABLED", 409);
      this.checkConnections(p.package, p.config.connections);
      for (const c of Object.values(p.config.connections))
        if (c.auth !== "none" && !c.secret) pluginError("SECRET_REQUIRED", 409);
    }
    const settings = await this.runtimeSettings();
    const usage = pluginCatalogueUsage(this, plugins);
    if (usage.toolCount > pluginLimits.tools)
      throw new ApplicationError(
        "PLUGIN_TOO_MANY_TOOLS",
        `插件工具数量 ${usage.toolCount} 超过上限 ${pluginLimits.tools}。请减少启用的工具。`,
        409,
      );
    if (usage.characters > settings.catalogueCharacters)
      throw new ApplicationError(
        "PLUGIN_CATALOGUE_TOO_LARGE",
        `插件目录占用 ${usage.characters} 字符，超过上限 ${settings.catalogueCharacters}。请减少启用的工具，或在系统设置 → 插件工具预算调整上限。`,
        409,
      );
  }
  async remove(id: string, version: number) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE workflow_versions IN SHARE MODE");
      const refs = await client.query(
        "SELECT workflow_id,version FROM workflow_versions WHERE definition::text LIKE $1",
        [`%${id}%`],
      );
      if (refs.rows.length) pluginError("WORKFLOW_REFERENCES_EXIST", 409);
      const p = (
        await client.query(
          "SELECT version FROM plugins WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0] as { version: number } | undefined;
      if (!p || p.version !== version) pluginError("CONFLICT", 409);
      await client.query(
        "UPDATE plugin_imports SET installed_plugin_id=NULL WHERE installed_plugin_id=$1",
        [id],
      );
      await client.query("DELETE FROM plugin_versions WHERE plugin_id=$1", [
        id,
      ]);
      await client.query("DELETE FROM plugins WHERE id=$1", [id]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
import {
  imageExportTargets,
  assertImageExportBinding,
  findImageExportTarget,
} from "./plugin-image-exports.js";
import {
  type ImageReply,
  needsFileExport,
} from "../generated-images/image-policy.js";
