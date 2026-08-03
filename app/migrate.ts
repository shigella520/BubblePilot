import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required to run migrations.");
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query(
    "SELECT pg_advisory_lock(hashtext('bubblepilot-migrations'))",
  );
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  const migrationsDirectory = resolve(process.cwd(), "migrations");
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const migrationName of migrationNames) {
    const applied = await client.query(
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      [migrationName],
    );
    if (applied.rowCount !== 0) {
      continue;
    }

    const sql = await readFile(
      resolve(migrationsDirectory, migrationName),
      "utf8",
    );
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        migrationName,
      ]);
      await client.query("COMMIT");
      process.stdout.write(`Applied migration ${migrationName}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query(
    "SELECT pg_advisory_unlock(hashtext('bubblepilot-migrations'))",
  );
  await client.end();
}
