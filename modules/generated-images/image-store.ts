import { constants } from "node:fs";
import {
  mkdir,
  open,
  lstat,
  realpath,
  readdir,
  rm,
  rename,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { Pool } from "pg";
import { validateReplyFile } from "./file-validation.js";
export { validateGeneratedPng } from "./file-validation.js";
import {
  GeneratedImageError,
  type ReplyFileType,
  type GeneratedImageRef,
} from "./image-policy.js";
export interface ImageOwner {
  executionId: string;
  nodeId: string;
  runId: string;
  pluginId: string;
  server: string;
  chatId: string;
}
export interface ImageArtifact {
  id: string;
  execution_id: string;
  node_id: string;
  run_id: string;
  provider_chat_id: string;
  storage_key: string;
  sha256: string;
  size: number;
  width: number | null;
  height: number | null;
  filename: string;
  mime_type: string;
  file_type: ReplyFileType;
  state: "ready" | "bound" | "deleting" | "deleted";
  expires_at: Date;
}
export class GeneratedImageStore {
  constructor(
    readonly pool: Pool,
    readonly root: string,
    readonly maximumBytes = 1024 * 1024 * 1024,
    readonly retentionDays = 30,
  ) {}
  async init(forbiddenRoots: string[] = []) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = await realpath(this.root),
      info = await lstat(this.root);
    for (const root of forbiddenRoots) {
      const forbidden = await realpath(root).catch(() => resolve(root));
      if (
        target === forbidden ||
        target.startsWith(forbidden + "/") ||
        forbidden.startsWith(target + "/")
      )
        throw new Error(
          "Generated image storage overlaps another data directory",
        );
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Generated image storage must be private");
  }
  private file(key: string) {
    if (!/^[a-f0-9-]{36}\.(?:png|file)(?:\.partial)?$/.test(key))
      throw new GeneratedImageError("GENERATED_IMAGE_UNAVAILABLE");
    return join(this.root, key);
  }
  async save(
    owner: ImageOwner,
    bytes: Buffer,
    signal: AbortSignal,
    options: { filename: string; allowedTypes: readonly ReplyFileType[] } = {
      filename: "chart.png",
      allowedTypes: ["png"],
    },
  ): Promise<ImageArtifact> {
    const image = await validateReplyFile(
      bytes,
      options.filename,
      options.allowedTypes,
      signal,
    );
    signal.throwIfAborted();
    const client = await this.pool.connect();
    const key = `${randomUUID()}.file`;
    let written = false,
      committed = false;
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('generated-image-storage',0))",
      );
      const allowed = await client.query(
        `SELECT e.id FROM workflow_executions e JOIN messages m ON m.id=e.source_message_id JOIN chats c ON c.id=m.chat_id WHERE e.id=$1 AND e.status='running' AND c.provider_chat_id=$2 AND c.enabled AND c.deleted_at IS NULL AND NOT m.is_from_me AND m.content_redacted_at IS NULL`,
        [owner.executionId, owner.chatId],
      );
      if (!allowed.rowCount)
        throw new GeneratedImageError("IMAGE_TRIGGER_NOT_AUTHORIZED");
      const old = (
        await client.query<ImageArtifact>(
          "SELECT * FROM generated_image_artifacts WHERE run_id=$1 AND sha256=$2 AND filename=$3 AND file_type=$4 AND state='ready' AND expires_at>now()",
          [owner.runId, image.sha256, image.filename, image.fileType],
        )
      ).rows[0];
      if (old) {
        await client.query("COMMIT");
        committed = true;
        return old;
      }
      let occupied = 0;
      for (const name of await readdir(this.root)) {
        const info = await lstat(join(this.root, name));
        if (info.isFile()) occupied += info.size;
      }
      if (occupied + bytes.length > this.maximumBytes)
        throw new GeneratedImageError("IMAGE_STORAGE_FULL");
      const fd = await open(this.file(key + ".partial"), "wx", 0o600);
      try {
        await fd.writeFile(bytes);
        await fd.sync();
      } finally {
        await fd.close();
      }
      signal.throwIfAborted();
      await rename(this.file(key + ".partial"), this.file(key));
      written = true;
      const dir = await open(this.root, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      const result = await client.query<ImageArtifact>(
        `INSERT INTO generated_image_artifacts(id,execution_id,node_id,run_id,plugin_id,server,provider_chat_id,storage_key,sha256,size,width,height,state,expires_at,filename,mime_type,file_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ready',now()+$13*interval '1 day',$14,$15,$16) RETURNING *`,
        [
          randomUUID(),
          owner.executionId,
          owner.nodeId,
          owner.runId,
          owner.pluginId,
          owner.server,
          owner.chatId,
          key,
          image.sha256,
          image.size,
          image.width,
          image.height,
          this.retentionDays,
          image.filename,
          image.mimeType,
          image.fileType,
        ],
      );
      signal.throwIfAborted();
      await client.query("COMMIT");
      committed = true;
      return result.rows[0]!;
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      await rm(this.file(key + ".partial"), { force: true });
      // A COMMIT response can be lost: leave the final file for the orphan reconciler.
      if (!written) await rm(this.file(key), { force: true });
    }
  }
  async read(id: string, executionId: string) {
    const row = (
      await this.pool.query<ImageArtifact>(
        "SELECT a.* FROM generated_image_artifacts a WHERE id=$1 AND execution_id=$2 AND state IN ('ready','bound') AND expires_at>now() AND NOT EXISTS(SELECT 1 FROM workflow_executions e JOIN messages m ON m.id=e.source_message_id WHERE e.id=a.execution_id AND m.content_redacted_at IS NOT NULL)",
        [id, executionId],
      )
    ).rows[0];
    if (!row) throw new GeneratedImageError("GENERATED_IMAGE_UNAVAILABLE");
    const fd = await open(
      this.file(row.storage_key),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await fd.stat();
      if (!info.isFile() || info.size !== row.size)
        throw new GeneratedImageError("GENERATED_IMAGE_UNAVAILABLE");
      const data = Buffer.alloc(row.size + 1);
      let count = 0;
      while (count < data.length) {
        const part = await fd.read(data, count, data.length - count, null);
        if (!part.bytesRead) break;
        count += part.bytesRead;
      }
      const bytes = data.subarray(0, count);
      if (
        count !== row.size ||
        createHash("sha256").update(bytes).digest("hex") !== row.sha256
      )
        throw new GeneratedImageError("IMAGE_HASH_MISMATCH");
      return { row, bytes };
    } finally {
      await fd.close();
    }
  }
  async discard(runId: string, keep?: string) {
    await this.pool.query(
      "UPDATE generated_image_artifacts SET state='deleting' WHERE run_id=$1 AND state='ready' AND ($2::uuid IS NULL OR id<>$2)",
      [runId, keep ?? null],
    );
    await this.removeDeleted();
  }
  private async removeDeleted() {
    const rows = await this.pool.query<ImageArtifact>(
      "SELECT * FROM generated_image_artifacts WHERE state='deleting' LIMIT 100",
    );
    for (const row of rows.rows) {
      await rm(this.file(row.storage_key), { force: true });
      await this.pool.query(
        "UPDATE generated_image_artifacts SET state='deleted',deleted_at=now() WHERE id=$1 AND state='deleting'",
        [row.id],
      );
    }
  }
  async cleanup() {
    await this.pool.query(
      `UPDATE generated_image_artifacts a SET state='deleting' WHERE state='ready' AND (expires_at<=now() OR (created_at<now()-interval '1 hour' AND NOT EXISTS(SELECT 1 FROM workflow_executions e WHERE e.id=a.execution_id AND e.status IN ('running','created','retrying'))))`,
    );
    // Lock each expired artifact while retiring its deliveries to exclude a concurrent send claim.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const rows = await client.query<{ id: string }>(
        "SELECT a.id FROM generated_image_artifacts a WHERE state='bound' AND (expires_at<=now() OR EXISTS(SELECT 1 FROM workflow_executions e JOIN messages m ON m.id=e.source_message_id WHERE e.id=a.execution_id AND m.content_redacted_at IS NOT NULL)) FOR UPDATE SKIP LOCKED",
      );
      for (const row of rows.rows) {
        const active = await client.query(
          `SELECT d.id FROM outbound_deliveries d JOIN outbound_reply_plans p ON d.id=p.image_delivery_id OR d.id=p.text_delivery_id WHERE p.artifact_id=$1 AND d.status='sending' AND d.send_lease_until>now()`,
          [row.id],
        );
        if (active.rowCount) continue;
        await client.query(
          `UPDATE outbound_deliveries SET closed_at=COALESCE(closed_at,now()),retryable=false,error_code=CASE WHEN status IN ('pending','failed') THEN 'GENERATED_IMAGE_EXPIRED' ELSE error_code END,status=CASE WHEN status='pending' THEN 'failed' WHEN status='sending' THEN 'unknown' ELSE status END,updated_at=now() WHERE id IN (SELECT image_delivery_id FROM outbound_reply_plans WHERE artifact_id=$1 UNION SELECT text_delivery_id FROM outbound_reply_plans WHERE artifact_id=$1) AND status<>'confirmed'`,
          [row.id],
        );
        await client.query(
          "UPDATE generated_image_artifacts SET state='deleting' WHERE id=$1",
          [row.id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await this.removeDeleted();
    for (const name of await readdir(this.root)) {
      if (!/^[a-f0-9-]{36}\.(?:png|file)(?:\.partial)?$/.test(name)) continue;
      const info = await lstat(this.file(name));
      if (!info.isFile() || Date.now() - info.mtimeMs < 3600_000) continue;
      const exists = await this.pool.query(
        "SELECT id FROM generated_image_artifacts WHERE storage_key=$1 AND state<>'deleted'",
        [name],
      );
      if (!exists.rowCount) await rm(this.file(name), { force: true });
    }
  }
  ref(row: ImageArtifact): GeneratedImageRef {
    return { id: row.id, sha256: row.sha256, executionId: row.execution_id };
  }
  async list(executionId: string) {
    return (
      await this.pool.query(
        `SELECT a.id,a.filename,a.mime_type AS "mimeType",a.file_type AS "fileType",a.width,a.height,a.size,a.sha256,a.state,a.expires_at AS "expiresAt",a.created_at AS "createdAt",d.status AS "deliveryStatus",d.error_code AS "errorCode",d.error_summary AS "errorSummary",d.id AS "deliveryId",d.retryable,d.closed_at AS "closedAt" FROM generated_image_artifacts a LEFT JOIN outbound_deliveries d ON d.generated_image_id=a.id WHERE a.execution_id=$1 ORDER BY a.created_at`,
        [executionId],
      )
    ).rows as Record<string, unknown>[];
  }
}
