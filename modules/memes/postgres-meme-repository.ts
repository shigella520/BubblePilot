import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createPostgresPool } from "../shared/postgres-pool.js";
import type {
  MemeAsset,
  MemeRepository,
  MemeSummaryJob,
} from "./meme-types.js";
const columns = `id,name,description,tags,summary,summary_manual AS "summaryManual",candidate_summary AS "candidateSummary",summary_status AS "summaryStatus",summary_error AS "summaryError",enabled,mime_type AS "mimeType",size,width,height,hash,storage_key AS "storageKey",version,created_at::text AS "createdAt",updated_at::text AS "updatedAt",deleted_at::text AS "deletedAt"`;
export class PostgresMemeRepository implements MemeRepository {
  readonly pool: Pool;
  constructor(databaseUrl: string, timeoutMs?: number) {
    this.pool = createPostgresPool(databaseUrl, 3, timeoutMs);
  }
  async get(id: string) {
    return (
      (
        await this.pool.query<MemeAsset>(
          `SELECT ${columns} FROM meme_assets WHERE id=$1 AND deleted_at IS NULL`,
          [id],
        )
      ).rows[0] ?? null
    );
  }
  async list(input: Parameters<MemeRepository["list"]>[0]) {
    const values = [
      input.query ?? "",
      input.enabled ?? null,
      input.status ?? null,
    ];
    const where = `deleted_at IS NULL AND ($1='' OR position(lower($1) in lower(name || ' ' || tags::text))>0) AND ($2::boolean IS NULL OR enabled=$2) AND ($3::text IS NULL OR summary_status=$3)`;
    const items = await this.pool.query<MemeAsset>(
      `SELECT ${columns} FROM meme_assets WHERE ${where} ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`,
      [...values, input.limit, input.offset],
    );
    const total = await this.pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM meme_assets WHERE ${where}`,
      values,
    );
    return { items: items.rows, total: Number(total.rows[0]?.total ?? 0) };
  }
  async create(input: Parameters<MemeRepository["create"]>[0]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize equal hashes, including concurrent duplicate uploads.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [input.hash],
      );
      const old = await client.query<MemeAsset>(
        `SELECT ${columns} FROM meme_assets WHERE hash=$1 AND deleted_at IS NULL`,
        [input.hash],
      );
      if (old.rows[0]) {
        await client.query("COMMIT");
        return { asset: old.rows[0], created: false };
      }
      const id = randomUUID();
      const result = await client.query<MemeAsset>(
        `INSERT INTO meme_assets(id,name,description,tags,mime_type,size,width,height,hash,storage_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${columns}`,
        [
          id,
          input.name,
          input.description,
          JSON.stringify(input.tags),
          input.mimeType,
          input.size,
          input.width,
          input.height,
          input.hash,
          input.storageKey,
        ],
      );
      await client.query(
        "INSERT INTO meme_summary_jobs(id,meme_id,base_version) VALUES($1,$2,1)",
        [randomUUID(), id],
      );
      await client.query("COMMIT");
      return { asset: result.rows[0]!, created: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async edit(id: string, input: Parameters<MemeRepository["edit"]>[1]) {
    return (
      (
        await this.pool.query<MemeAsset>(
          `UPDATE meme_assets SET name=$3,description=$4,tags=$5,summary=CASE WHEN $6::text IS NULL THEN summary ELSE $6 END,summary_manual=summary_manual OR $6::text IS NOT NULL,enabled=coalesce($7,enabled),version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND deleted_at IS NULL RETURNING ${columns}`,
          [
            id,
            input.expectedVersion,
            input.name,
            input.description,
            JSON.stringify(input.tags),
            input.summary ?? null,
            input.enabled ?? null,
          ],
        )
      ).rows[0] ?? null
    );
  }
  async remove(id: string, version: number) {
    return (
      (
        await this.pool.query(
          "UPDATE meme_assets SET deleted_at=now(),enabled=false,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND deleted_at IS NULL",
          [id, version],
        )
      ).rowCount === 1
    );
  }
  async enqueue(id: string, version: number, candidate: boolean) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        "UPDATE meme_assets SET summary_status='pending',summary_error=NULL,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM meme_summary_jobs WHERE meme_id=$1 AND status IN ('pending','processing')) RETURNING version",
        [id, version],
      );
      if (!updated.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        "INSERT INTO meme_summary_jobs(id,meme_id,base_version,candidate) VALUES($1,$2,$3,$4)",
        [randomUUID(), id, version + 1, candidate],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async adopt(id: string, version: number) {
    return (
      (
        await this.pool.query<MemeAsset>(
          `UPDATE meme_assets SET summary=candidate_summary,candidate_summary=NULL,summary_manual=true,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND deleted_at IS NULL AND candidate_summary IS NOT NULL RETURNING ${columns}`,
          [id, version],
        )
      ).rows[0] ?? null
    );
  }
  async claim(owner: string): Promise<MemeSummaryJob | null> {
    // Exhausted crashed jobs are terminal rather than stuck in processing forever.
    await this.pool.query(
      "WITH exhausted AS (UPDATE meme_summary_jobs SET status='failed',lease_owner=NULL WHERE status='processing' AND lease_until<now() AND attempt>=3 RETURNING meme_id) UPDATE meme_assets SET summary_status='failed',summary_error='MEME_SUMMARY_LEASE_EXHAUSTED' WHERE id IN (SELECT meme_id FROM exhausted)",
    );
    const result = await this.pool.query<MemeSummaryJob>(
      `WITH picked AS (SELECT j.id FROM meme_summary_jobs j JOIN meme_assets a ON a.id=j.meme_id WHERE a.deleted_at IS NULL AND j.attempt<3 AND ((j.status='pending' AND j.next_attempt_at<=now()) OR (j.status='processing' AND j.lease_until<now())) ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1), claimed AS (UPDATE meme_summary_jobs SET status='processing',attempt=attempt+1,lease_owner=$1,lease_until=now()+interval '10 minutes' WHERE id IN (SELECT id FROM picked) RETURNING id,meme_id,attempt,base_version,candidate), marked AS (UPDATE meme_assets SET summary_status='processing' WHERE id IN(SELECT meme_id FROM claimed)) SELECT id,meme_id AS "memeId",$1::text AS owner,attempt,base_version AS "baseVersion",candidate FROM claimed`,
      [owner],
    );
    return result.rows[0] ?? null;
  }
  async complete(job: MemeSummaryJob, summary: string) {
    const result = await this.pool.query(
      `WITH finished AS (UPDATE meme_summary_jobs SET status='succeeded',lease_owner=NULL WHERE id=$1 AND lease_owner=$2 AND status='processing' AND lease_until>now() RETURNING meme_id) UPDATE meme_assets SET summary=CASE WHEN NOT $4 AND NOT summary_manual AND version=$5 THEN $3 ELSE summary END,candidate_summary=CASE WHEN $4 OR summary_manual OR version<>$5 THEN $3 ELSE candidate_summary END,summary_status='succeeded',summary_error=NULL,version=version+1,updated_at=now() WHERE id IN(SELECT meme_id FROM finished) AND deleted_at IS NULL`,
      [job.id, job.owner, summary, job.candidate, job.baseVersion],
    );
    return result.rowCount === 1;
  }
  async fail(job: MemeSummaryJob, code: string) {
    await this.pool.query(
      `WITH failed AS (UPDATE meme_summary_jobs SET status=CASE WHEN attempt<3 THEN 'pending' ELSE 'failed' END,lease_owner=NULL,next_attempt_at=now()+interval '30 seconds' WHERE id=$1 AND lease_owner=$2 AND status='processing' AND lease_until>now() RETURNING meme_id,status) UPDATE meme_assets SET summary_status=failed.status,summary_error=$3 FROM failed WHERE meme_assets.id=failed.meme_id AND deleted_at IS NULL`,
      [job.id, job.owner, code],
    );
  }
  async search(query: string, limit: number) {
    const words = [
      ...new Set(query.toLowerCase().trim().split(/\s+/u).filter(Boolean)),
    ].slice(0, 20);
    if (!words.length)
      return (
        await this.pool.query<MemeAsset>(
          `SELECT ${columns} FROM meme_assets WHERE deleted_at IS NULL AND enabled ORDER BY created_at DESC,id LIMIT $1`,
          [limit],
        )
      ).rows;
    return (
      await this.pool.query<MemeAsset>(
        `SELECT ${columns} FROM meme_assets a WHERE deleted_at IS NULL AND enabled AND EXISTS(SELECT 1 FROM unnest($1::text[]) w WHERE position(w in lower(name || ' ' || tags::text || ' ' || description || ' ' || coalesce(summary,'')))>0) ORDER BY (SELECT sum((CASE WHEN position(w in lower(name))>0 THEN 8 ELSE 0 END)+(CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements_text(tags) t WHERE position(w in lower(t))>0) THEN 8 ELSE 0 END)+(CASE WHEN position(w in lower(description))>0 THEN 2 ELSE 0 END)+(CASE WHEN position(w in lower(coalesce(summary,'')))>0 THEN 1 ELSE 0 END)) FROM unnest($1::text[]) w) DESC,(SELECT count(*) FROM unnest($1::text[]) w WHERE position(w in lower(name || ' ' || tags::text || ' ' || description || ' ' || coalesce(summary,'')))>0) DESC,id LIMIT $2`,
        [words, limit],
      )
    ).rows;
  }
  async storageKeys() {
    return (
      await this.pool.query<{ storage_key: string }>(
        "SELECT storage_key FROM meme_assets a WHERE deleted_at IS NULL OR deleted_at>now()-interval '24 hours' OR EXISTS(SELECT 1 FROM outbound_deliveries d JOIN workflow_executions e ON e.id=d.execution_id WHERE e.status<>'closed' AND d.meme_id=a.id AND d.closed_at IS NULL AND d.status IN ('pending','sending','unknown','failed'))",
      )
    ).rows.map((row) => row.storage_key);
  }
  close() {
    return this.pool.end();
  }
}
