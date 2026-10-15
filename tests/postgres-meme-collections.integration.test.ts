import { randomUUID } from "node:crypto";
import { afterAll, describe, it, expect } from "vitest";
import { PostgresMemeRepository } from "../modules/memes/postgres-meme-repository.js";
import type { MemeAsset, MemeSummaryJob } from "../modules/memes/meme-types.js";
const url = process.env.TEST_DATABASE_URL;
describe.runIf(!!url)("meme collections and fixed selection", () => {
  const repo = new PostgresMemeRepository(url ?? "");
  const assetIds: string[] = [],
    collectionIds: string[] = [];
  async function collection() {
    const c = await repo.createCollection({
      name: "虚构系列-" + randomUUID(),
      description: "fixture",
    });
    collectionIds.push(c.id);
    return c;
  }
  async function asset(collectionId?: string) {
    const a = (
      await repo.create({
        name: "虚构素材-" + randomUUID(),
        description: "",
        tags: [],
        mimeType: "image/png",
        size: 1,
        width: 1,
        height: 1,
        hash: randomUUID(),
        storageKey: randomUUID(),
        collectionId,
      })
    ).asset;
    assetIds.push(a.id);
    await repo.pool.query(
      "UPDATE meme_summary_jobs SET status='succeeded' WHERE meme_id=$1",
      [a.id],
    );
    return a;
  }
  afterAll(async () => {
    await repo.pool.query(
      "UPDATE meme_collections SET cover_meme_id=NULL WHERE id=ANY($1::uuid[])",
      [collectionIds],
    );
    await repo.pool.query(
      "DELETE FROM meme_summary_jobs WHERE meme_id=ANY($1::uuid[])",
      [assetIds],
    );
    await repo.pool.query("DELETE FROM meme_assets WHERE id=ANY($1::uuid[])", [
      assetIds,
    ]);
    await repo.pool.query(
      "DELETE FROM meme_collections WHERE id=ANY($1::uuid[])",
      [collectionIds],
    );
    await repo.close();
  });
  it("validates names, membership, cover fallback and safe collection deletion", async () => {
    const c = await collection(),
      a = await asset(c.id),
      b = await asset(c.id);
    await expect(
      repo.createCollection({ name: c.name, description: "" }),
    ).rejects.toMatchObject({ code: "MEME_COLLECTION_NAME_EXISTS" });
    expect(
      await repo.editCollection(c.id, {
        name: c.name,
        description: "",
        expectedVersion: 99,
      }),
    ).toBeNull();
    await expect(
      repo.editCollection(c.id, {
        name: c.name,
        description: "",
        expectedVersion: 1,
        coverMemeId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "MEME_COLLECTION_COVER_INVALID" });
    const updated = await repo.editCollection(c.id, {
      name: c.name,
      description: "",
      expectedVersion: 1,
      coverMemeId: b.id,
    });
    expect(updated?.effectiveCoverMemeId).toBe(b.id);
    await repo.batch({
      items: [{ id: b.id, expectedVersion: 1 }],
      action: { type: "move", collectionId: null },
    });
    expect(
      (await repo.listCollections()).items.find((x) => x.id === c.id),
    ).toMatchObject({ count: 1, effectiveCoverMemeId: a.id });
    expect(await repo.removeCollection(c.id, 1)).toBe(false);
    expect(await repo.removeCollection(c.id, updated!.version)).toBe(true);
    expect(await repo.get(a.id)).toMatchObject({
      collectionId: null,
      enabled: true,
      summaryInputVersion: 1,
    });
  });
  it("deduplicates globally without moving assets; legacy edits retain membership", async () => {
    const c = await collection(),
      a = await asset(c.id);
    const again = await repo.create({
      ...a,
      storageKey: randomUUID(),
      collectionId: randomUUID(),
    });
    expect(again.created).toBe(false);
    expect(again.asset.collectionId).toBe(c.id);
    const edited = await repo.edit(a.id, {
      name: a.name,
      description: a.description,
      tags: a.tags,
      enabled: false,
      expectedVersion: a.version,
    });
    expect(edited).toMatchObject({
      collectionId: c.id,
      summaryInputVersion: 1,
    });
    await expect(asset(randomUUID())).rejects.toMatchObject({
      code: "MEME_COLLECTION_NOT_FOUND",
    });
  });
  it("freezes 424 IDs, excludes later additions and reports conflicts per item", async () => {
    const c = await collection();
    const made: MemeAsset[] = [];
    for (let i = 0; i < 424; i++) made.push(await asset(c.id));
    const selected = await repo.selection({ collection: c.id });
    expect(selected).toHaveLength(424);
    const later = await asset(c.id);
    expect(selected.some((x) => x.id === later.id)).toBe(false);
    await repo.edit(made[0]!.id, {
      name: made[0]!.name,
      description: "concurrent edit",
      tags: [],
      expectedVersion: 1,
    });
    const results = [];
    for (let offset = 0; offset < selected.length; offset += 100)
      results.push(
        ...(await repo.batch({
          items: selected.slice(offset, offset + 100),
          action: { type: "enable", enabled: false },
        })),
      );
    expect(results.filter((r) => r.status === "succeeded")).toHaveLength(423);
    expect(results.filter((r) => r.status === "conflict")).toHaveLength(1);
    expect((await repo.get(later.id))?.enabled).toBe(true);
    const deleted = made[1]!;
    const current = (await repo.get(deleted.id))!;
    await repo.batch({
      items: [{ id: deleted.id, expectedVersion: current.version }],
      action: { type: "delete" },
    });
    expect(await repo.get(deleted.id)).toBeNull();
    expect(await repo.storageKeys()).toContain(deleted.storageKey);
  }, 30000);
  it("rejects an oversized selection rather than returning a partial set", async () => {
    const c = await collection();
    const inserted = await repo.pool.query<{ id: string }>(
      `INSERT INTO meme_assets(id,name,mime_type,size,width,height,hash,storage_key,collection_id)
       SELECT gen_random_uuid(),'虚构上限测试','image/png',1,1,1,
       gen_random_uuid()::text,gen_random_uuid()::text,$1 FROM generate_series(1,5001) RETURNING id`,
      [c.id],
    );
    assetIds.push(...inserted.rows.map((r) => r.id));
    await expect(repo.selection({ collection: c.id })).rejects.toMatchObject({
      code: "MEME_SELECTION_LIMIT",
    });
    const id = randomUUID();
    expect(
      await repo.batch({
        items: [{ id, expectedVersion: 1 }],
        action: { type: "delete" },
      }),
    ).toEqual([{ id, status: "missing" }]);
  });
  it("prevents dangling membership when deletion races a move", async () => {
    const c = await collection(),
      a = await asset();
    await Promise.allSettled([
      repo.removeCollection(c.id, c.version),
      repo.batch({
        items: [{ id: a.id, expectedVersion: 1 }],
        action: { type: "move", collectionId: c.id },
      }),
    ]);
    expect((await repo.get(a.id))?.collectionId).toBeNull();
  });
  it("includes collection names at description weight, and filters disabled assets", async () => {
    const c = await collection(),
      a = await asset(c.id);
    expect((await repo.search(c.name, 10)).map((r) => r.id)).toContain(a.id);
    const b = await asset();
    await repo.edit(b.id, {
      name: c.name,
      description: "",
      tags: [],
      expectedVersion: 1,
    });
    expect((await repo.search(c.name, 10))[0]?.id).toBe(b.id);
    await repo.batch({
      items: [{ id: a.id, expectedVersion: 1 }],
      action: { type: "enable", enabled: false },
    });
    expect((await repo.search(c.name, 10)).map((r) => r.id)).not.toContain(
      a.id,
    );
  });
  async function jobFor(a: MemeAsset, legacy = false) {
    const row = (
      await repo.pool.query<{ id: string }>(
        "UPDATE meme_summary_jobs SET status='processing',lease_owner='fixture',lease_until=now()+interval '1 minute',input_version=CASE WHEN $2 THEN NULL ELSE 1 END WHERE meme_id=$1 RETURNING id",
        [a.id, legacy],
      )
    ).rows[0]!;
    return {
      id: row.id,
      memeId: a.id,
      owner: "fixture",
      attempt: 1,
      baseVersion: 1,
      inputVersion: legacy ? null : 1,
      candidate: false,
    } satisfies MemeSummaryJob;
  }
  it("allows summary completion after moves/enabling but protects input edits and legacy jobs", async () => {
    const c = await collection(),
      a = await asset(),
      job = await jobFor(a);
    await repo.batch({
      items: [{ id: a.id, expectedVersion: 1 }],
      action: { type: "move", collectionId: c.id },
    });
    await repo.batch({
      items: [{ id: a.id, expectedVersion: 2 }],
      action: { type: "enable", enabled: false },
    });
    await repo.complete(job, "虚构自动摘要");
    expect(await repo.get(a.id)).toMatchObject({
      summary: "虚构自动摘要",
      candidateSummary: null,
    });
    const b = await asset(),
      oldJob = await jobFor(b, true);
    await repo.batch({
      items: [{ id: b.id, expectedVersion: 1 }],
      action: { type: "move", collectionId: c.id },
    });
    await repo.complete(oldJob, "旧任务结果");
    expect(await repo.get(b.id)).toMatchObject({
      summary: null,
      candidateSummary: "旧任务结果",
    });
    const d = await asset(),
      newJob = await jobFor(d);
    await repo.edit(d.id, {
      name: "人工修改名称",
      description: "",
      tags: [],
      expectedVersion: 1,
    });
    await repo.complete(newJob, "输入已过期");
    expect(await repo.get(d.id)).toMatchObject({
      summary: null,
      candidateSummary: "输入已过期",
      summaryInputVersion: 2,
    });
  });
});
