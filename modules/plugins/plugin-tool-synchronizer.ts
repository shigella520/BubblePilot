import { randomUUID } from "node:crypto";
import type { PluginService } from "./plugin-service.js";
import type { ApprovedTool, InstalledPlugin } from "./plugin-types.js";
import {
  canonicalToolValue,
  compareTools,
  type ToolSyncRecord,
} from "./plugin-tool-sync.js";

export interface ToolObservation {
  plugin: InstalledPlugin;
  server: string;
  tools: ApprovedTool[];
}
/** Per-plugin PostgreSQL lock prevents overlapping hourly/call checks across processes. */
export class PluginToolSynchronizer {
  constructor(private readonly service: PluginService) {}
  async check(
    id: string,
    source: ToolSyncRecord["source"],
    observation?: ToolObservation,
  ) {
    const client = await this.service.pool.connect();
    let locked = false;
    try {
      locked = (
        await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext('plugin-tool-sync'),hashtext($1)) AS locked",
          [id],
        )
      ).rows[0]!.locked;
      if (!locked) return;
      const p = await this.service.get(id);
      if (!p.enabled || !p.config.autoSyncTools) return;
      if (
        source === "scheduled" &&
        p.toolSyncLastCheck &&
        Date.now() - Date.parse(p.toolSyncLastCheck) < 3_600_000
      )
        return;
      if (
        observation &&
        (p.version !== observation.plugin.version ||
          p.revision !== observation.plugin.revision)
      )
        return;
      const record: ToolSyncRecord = {
        checkedAt: new Date().toISOString(),
        source,
        status: "unchanged",
        changes: [],
      };
      const config = { ...p.config, tools: [...p.config.tools] };
      const pending = new Set(p.pendingReview ?? []);
      let updated = false;
      try {
        const servers = observation
          ? [observation.server]
          : Object.keys(p.config.connections);
        for (const server of servers) {
          const approved = p.config.tools.filter(
            (t) =>
              t.server === server &&
              !p.config.disabledTools.includes(
                `${server}/${t.definition.name}`,
              ),
          );
          if (!approved.length) continue;
          const discovered = observation
            ? observation.tools
            : await this.service.discover({
                [server]: p.config.connections[server]!,
              });
          for (const tool of approved) {
            const next = discovered.find(
              (t) =>
                t.server === server &&
                t.definition.name === tool.definition.name,
            );
            const change = compareTools(tool, next);
            if (change.kind !== "unchanged") record.changes.push(change);
            if (change.kind === "review") pending.add(change.tool);
            else {
              pending.delete(change.tool);
              if (next && tool.hash !== next.hash) {
                config.tools[config.tools.indexOf(tool)] = next;
                updated = true;
              }
            }
          }
        }
        record.status = record.changes.some((c) => c.kind === "review")
          ? "review"
          : updated
            ? "updated"
            : "unchanged";
      } catch {
        // No raw transport messages: they can contain addresses or credentials.
        record.status = "failed";
        record.errorCode = "PLUGIN_TOOL_SYNC_DISCOVERY_FAILED";
        record.changes = [];
        updated = false;
      }
      await client.query("BEGIN");
      const row = (
        await client.query<{
          version: number;
          revision: string;
          metadata: Record<string, unknown>;
        }>(
          "SELECT p.version,p.revision,v.metadata FROM plugins p JOIN plugin_versions v ON v.plugin_id=p.id AND v.hash=p.revision WHERE p.id=$1 FOR UPDATE OF p,v",
          [id],
        )
      ).rows[0];
      if (!row || row.version !== p.version || row.revision !== p.revision) {
        await client.query("ROLLBACK");
        return;
      }
      const history = (row.metadata.toolSyncHistory ?? []) as ToolSyncRecord[];
      const previous = history[0];
      const changed =
        updated ||
        !previous ||
        previous.status !== record.status ||
        JSON.stringify(canonicalToolValue(previous.changes)) !==
          JSON.stringify(canonicalToolValue(record.changes));
      const metadata = {
        ...row.metadata,
        toolSyncLastCheck: record.checkedAt,
        ...(record.status !== "failed" ? { pendingReview: [...pending] } : {}),
        toolSyncHistory: changed ? [record, ...history].slice(0, 10) : history,
      };
      await client.query(
        "UPDATE plugin_versions SET metadata=$3,encrypted_config=COALESCE($4,encrypted_config) WHERE plugin_id=$1 AND hash=$2",
        [
          id,
          p.revision,
          JSON.stringify(metadata),
          updated ? this.service.cipher.encrypt(JSON.stringify(config)) : null,
        ],
      );
      if (updated)
        await client.query(
          "UPDATE plugins SET version=version+1,updated_at=now() WHERE id=$1",
          [id],
        );
      if (changed && record.status !== "unchanged")
        await client.query(
          `INSERT INTO audit_events(id,actor_type,action,target_type,target_id,outcome,correlation_id,metadata)
         VALUES($1,'system','plugin.tools.sync','plugin',$2,$3,$4,$5)`,
          [
            randomUUID(),
            id,
            record.status === "failed" ? "failed" : "succeeded",
            randomUUID(),
            JSON.stringify({
              source,
              status: record.status,
              changedTools: record.changes.length,
              revision: p.revision,
              ...(record.errorCode ? { errorCode: record.errorCode } : {}),
            }),
          ],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      let discard = false;
      if (locked)
        await client
          .query(
            "SELECT pg_advisory_unlock(hashtext('plugin-tool-sync'),hashtext($1))",
            [id],
          )
          .catch(() => {
            discard = true;
          });
      // Never return a connection with an uncertain session lock to the pool.
      client.release(discard);
    }
  }
}
