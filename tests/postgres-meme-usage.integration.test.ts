import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { it, expect } from "vitest";
import { PostgresMemeRepository } from "../modules/memes/postgres-meme-repository.js";
const url = process.env.TEST_DATABASE_URL;
it.runIf(!!url)(
  "backfills and atomically counts confirmations exactly once without changing management metadata",
  async () => {
    const schema = "usage_" + randomUUID().replaceAll("-", "");
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    try {
      await pool.query(`CREATE TABLE meme_assets(id int PRIMARY KEY, version int DEFAULT 1, summary_input_version int DEFAULT 1, updated_at timestamptz DEFAULT '2020-01-01');
      CREATE TABLE outbound_deliveries(id int PRIMARY KEY, meme_id int REFERENCES meme_assets, kind text, status text, confirmed_at timestamptz, closed_at timestamptz);
      INSERT INTO meme_assets(id) VALUES(1),(2);
      INSERT INTO outbound_deliveries VALUES(1,1,'meme','confirmed','2025-01-01',NULL),(2,1,'meme','confirmed',NULL,NULL),(3,2,'text','confirmed','2025-01-01',NULL);`);
      await pool.query(
        await readFile(
          new URL("../migrations/0055_meme_usage.sql", import.meta.url),
          "utf8",
        ),
      );
      const stats = async () =>
        (
          await pool.query<{
            usage_count: string;
            last_used_at: Date | null;
            version: number;
            summary_input_version: number;
            updated_at: Date;
          }>("SELECT * FROM meme_assets WHERE id=1")
        ).rows[0]!;
      expect(await stats()).toMatchObject({
        usage_count: "2",
        version: 1,
        summary_input_version: 1,
        last_used_at: new Date("2025-01-01"),
      });
      await pool.query(
        "UPDATE outbound_deliveries SET status='confirmed', usage_counted=false WHERE id=1",
      );
      expect((await stats()).usage_count).toBe("2");
      await pool.query(
        "INSERT INTO outbound_deliveries(id,meme_id,kind,status) VALUES(4,1,'meme','failed'),(5,1,'meme','unknown')",
      );
      await pool.query(
        "UPDATE outbound_deliveries SET closed_at=now() WHERE id=5",
      );
      await pool.query(
        "UPDATE outbound_deliveries SET status='confirmed' WHERE id=5",
      );
      expect((await stats()).usage_count).toBe("2");
      await pool.query(
        "UPDATE outbound_deliveries SET status='confirmed',confirmed_at='2025-02-01' WHERE id=4",
      );
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          pool.query(
            "INSERT INTO outbound_deliveries(id,meme_id,kind,status,confirmed_at) VALUES($1,1,'meme','confirmed','2025-01-15')",
            [10 + i],
          ),
        ),
      );
      expect((await stats()).usage_count).toBe("13");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO outbound_deliveries(id,meme_id,kind,status) VALUES(30,1,'meme','confirmed')",
        );
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      await pool.query("DELETE FROM outbound_deliveries");
      expect(await stats()).toMatchObject({
        usage_count: "13",
        last_used_at: new Date("2025-02-01"),
        version: 1,
        summary_input_version: 1,
        updated_at: new Date("2020-01-01"),
      });
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
it.runIf(!!url)(
  "sorts all five dimensions with nulls, stable ties, pagination and collection filters",
  async () => {
    const repo = new PostgresMemeRepository(url!);
    const pool = new Pool({ connectionString: url });
    const ids: string[] = [];
    const collection = await repo.createCollection({
      name: "虚构排序" + randomUUID(),
      description: "",
    });
    try {
      for (let i = 0; i < 4; i++) {
        const { asset } = await repo.create({
          name: "虚构" + i,
          description: "",
          tags: [],
          collectionId: collection.id,
          mimeType: "image/png",
          size: 1,
          width: 1,
          height: 1,
          hash: randomUUID(),
          storageKey: randomUUID(),
        });
        ids.push(asset.id);
        await pool.query(
          "UPDATE meme_summary_jobs SET status='succeeded' WHERE meme_id=$1",
          [asset.id],
        );
        await pool.query(
          "UPDATE meme_assets SET created_at=$2,usage_count=$3,last_used_at=$4 WHERE id=$1",
          [
            asset.id,
            `2025-01-0${i + 1}`,
            [0, 2, 2, 1][i],
            i === 0 ? null : `2025-02-0${i + 1}`,
          ],
        );
      }
      const cases = {
        newest: [3, 2, 1, 0],
        oldest: [0, 1, 2, 3],
        "most-used": [2, 1, 3, 0],
        "least-used": [0, 3, 2, 1],
        "recently-used": [3, 2, 1, 0],
      } as const;
      for (const sort of Object.keys(cases) as (keyof typeof cases)[]) {
        const first = await repo.list({
          collection: collection.id,
          sort,
          offset: 0,
          limit: 2,
        });
        const second = await repo.list({
          collection: collection.id,
          sort,
          offset: 2,
          limit: 2,
        });
        expect([...first.items, ...second.items].map((a) => a.id)).toEqual(
          cases[sort].map((i) => ids[i]),
        );
        expect(first.total).toBe(4);
        expect(typeof first.items[0]!.usageCount).toBe("number");
      }
      const selection = await repo.selection({ collection: collection.id });
      await pool.query(
        "UPDATE meme_assets SET usage_count=usage_count+1 WHERE id=ANY($1::uuid[])",
        [ids],
      );
      expect(await repo.selection({ collection: collection.id })).toEqual(
        selection,
      );
    } finally {
      await pool.query(
        "DELETE FROM meme_summary_jobs WHERE meme_id=ANY($1::uuid[])",
        [ids],
      );
      await pool.query("DELETE FROM meme_assets WHERE id=ANY($1::uuid[])", [
        ids,
      ]);
      await pool.query("DELETE FROM meme_collections WHERE id=$1", [
        collection.id,
      ]);
      await repo.close();
      await pool.end();
    }
  },
);
