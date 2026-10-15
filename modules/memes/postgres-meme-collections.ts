import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ApplicationError } from "../../app/errors.js";
import {
  collectionLimits,
  type MemeFilter,
  type MemeCollection,
  type MemeCollectionRepository,
  type MemeSelectionItem,
  type MemeBatchResult,
} from "./meme-collection-types.js";
export const membershipLock =
  "SELECT pg_advisory_xact_lock(hashtext('meme-collections'))";
export async function validateCollection(
  client: PoolClient,
  id: string | null | undefined,
) {
  if (
    id &&
    !(await client.query("SELECT id FROM meme_collections WHERE id=$1", [id]))
      .rowCount
  )
    throw new ApplicationError(
      "MEME_COLLECTION_NOT_FOUND",
      "合集不存在，请刷新后重试。",
      404,
    );
}
export function memeWhere(input: MemeFilter) {
  const values = [
    input.query ?? "",
    input.enabled ?? null,
    input.status ?? null,
    input.collection ?? "all",
  ];
  return {
    values,
    where: `deleted_at IS NULL AND ($1='' OR position(lower($1) in lower(name || ' ' || tags::text))>0) AND ($2::boolean IS NULL OR enabled=$2) AND ($3::text IS NULL OR summary_status=$3) AND ($4='all' OR ($4='unclassified' AND collection_id IS NULL) OR collection_id::text=$4)`,
  };
}
const collectionColumns = `c.id,c.name,c.description,c.cover_meme_id AS "coverMemeId",c.version,c.created_at::text AS "createdAt",c.updated_at::text AS "updatedAt",(SELECT count(*)::int FROM meme_assets WHERE collection_id=c.id AND deleted_at IS NULL) AS count,coalesce((SELECT id FROM meme_assets WHERE id=c.cover_meme_id AND collection_id=c.id AND deleted_at IS NULL),(SELECT id FROM meme_assets WHERE collection_id=c.id AND deleted_at IS NULL ORDER BY collection_joined_at,id LIMIT 1)) AS "effectiveCoverMemeId"`;
export class PostgresMemeCollections implements MemeCollectionRepository {
  constructor(readonly pool: Pool) {}
  async listCollections() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const items = (
        await client.query<MemeCollection>(
          `SELECT ${collectionColumns} FROM meme_collections c ORDER BY c.name,c.id`,
        )
      ).rows;
      const counts = (
        await client.query<{ total: number; unclassified: number }>(
          `SELECT count(*)::int AS total,count(*) FILTER(WHERE collection_id IS NULL)::int AS unclassified FROM meme_assets WHERE deleted_at IS NULL`,
        )
      ).rows[0]!;
      await client.query("COMMIT");
      return { items, ...counts };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  private async changeCollection(
    id: string,
    input: Parameters<MemeCollectionRepository["createCollection"]>[0],
    version?: number,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(membershipLock);
      if (
        input.coverMemeId &&
        !(
          await client.query(
            "SELECT id FROM meme_assets WHERE id=$1 AND collection_id=$2 AND deleted_at IS NULL",
            [input.coverMemeId, id],
          )
        ).rowCount
      )
        throw new ApplicationError(
          "MEME_COLLECTION_COVER_INVALID",
          "封面必须是当前合集内的素材。",
          400,
        );
      const result =
        version === undefined
          ? await client.query(
              "INSERT INTO meme_collections(id,name,description) VALUES($1,$2,$3) RETURNING id",
              [id, input.name, input.description],
            )
          : await client.query(
              `UPDATE meme_collections SET name=$3,description=$4,cover_meme_id=CASE WHEN $5 THEN $6::uuid ELSE cover_meme_id END,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 RETURNING id`,
              [
                id,
                version,
                input.name,
                input.description,
                input.coverMemeId !== undefined,
                input.coverMemeId ?? null,
              ],
            );
      const out = result.rowCount
        ? (
            await client.query<MemeCollection>(
              `SELECT ${collectionColumns} FROM meme_collections c WHERE c.id=$1`,
              [id],
            )
          ).rows[0]!
        : null;
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK");
      if ((e as { code?: string }).code === "23505")
        throw new ApplicationError(
          "MEME_COLLECTION_NAME_EXISTS",
          "已有同名合集。",
          409,
        );
      throw e;
    } finally {
      client.release();
    }
  }
  async createCollection(
    input: Parameters<MemeCollectionRepository["createCollection"]>[0],
  ) {
    return (await this.changeCollection(randomUUID(), input))!;
  }
  async editCollection(
    id: string,
    input: Parameters<MemeCollectionRepository["editCollection"]>[1],
  ) {
    return this.changeCollection(id, input, input.expectedVersion);
  }
  async removeCollection(id: string, version: number) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(membershipLock);
      if (
        !(
          await client.query(
            "SELECT id FROM meme_collections WHERE id=$1 AND version=$2 FOR UPDATE",
            [id, version],
          )
        ).rowCount
      ) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        "UPDATE meme_assets SET collection_id=NULL,collection_joined_at=NULL,version=version+1,updated_at=now() WHERE collection_id=$1",
        [id],
      );
      await client.query("DELETE FROM meme_collections WHERE id=$1", [id]);
      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async selection(input: MemeFilter) {
    const { values, where } = memeWhere(input);
    const rows = (
      await this.pool.query<MemeSelectionItem>(
        `SELECT id,version AS "expectedVersion" FROM meme_assets WHERE ${where} ORDER BY created_at DESC,id LIMIT $5`,
        [...values, collectionLimits.selection + 1],
      )
    ).rows;
    if (rows.length > collectionLimits.selection)
      throw new ApplicationError(
        "MEME_SELECTION_LIMIT",
        "匹配结果超过 5000 张，请缩小筛选范围。",
        400,
      );
    return rows;
  }
  async batch(input: Parameters<MemeCollectionRepository["batch"]>[0]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(membershipLock);
      if (input.action.type === "move")
        await validateCollection(client, input.action.collectionId);
      const results: MemeBatchResult[] = [];
      // Stable lock order for overlapping batches; response preserves requested order.
      for (const item of [...input.items].sort((a, b) =>
        a.id.localeCompare(b.id),
      )) {
        const row = (
          await client.query<{ version: number }>(
            "SELECT version FROM meme_assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
            [item.id],
          )
        ).rows[0];
        if (!row) {
          results.push({ id: item.id, status: "missing" });
          continue;
        }
        if (row.version !== item.expectedVersion) {
          results.push({ id: item.id, status: "conflict" });
          continue;
        }
        const action = input.action;
        if (action.type === "move")
          await client.query(
            `UPDATE meme_assets SET collection_joined_at=CASE WHEN collection_id IS NOT DISTINCT FROM $2::uuid THEN collection_joined_at WHEN $2::uuid IS NULL THEN NULL ELSE now() END,collection_id=$2,version=version+1,updated_at=now() WHERE id=$1`,
            [item.id, action.collectionId],
          );
        else if (action.type === "enable")
          await client.query(
            "UPDATE meme_assets SET enabled=$2,version=version+1,updated_at=now() WHERE id=$1",
            [item.id, action.enabled],
          );
        else
          await client.query(
            "UPDATE meme_assets SET deleted_at=now(),enabled=false,version=version+1,updated_at=now() WHERE id=$1",
            [item.id],
          );
        results.push({
          id: item.id,
          status: "succeeded",
          version: row.version + 1,
        });
      }
      await client.query("COMMIT");
      return input.items.map((i) => results.find((r) => r.id === i.id)!);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
