import { memoryEmbeddingsDdl } from "../modules/memory/memory-embeddings-ddl.js";
import { Client } from "pg";
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(
    "SELECT pg_advisory_lock(hashtext('bubblepilot-memory-prepare'))",
  );
  const available = await client.query(
    "SELECT 1 FROM pg_available_extensions WHERE name='vector'",
  );
  if (!available.rowCount) {
    process.stdout.write(
      "pgvector unavailable; memory stays disabled. Existing features remain available.\n",
    );
  } else {
    await client.query("BEGIN");
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      for (const statement of memoryEmbeddingsDdl)
        await client.query(statement);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null;
      if (code === "42501" || code === "0A000") {
        process.stdout.write(
          "pgvector preparation unavailable; memory cannot be enabled. Existing features remain available.\n",
        );
      } else throw error;
    }
  }
} finally {
  await client.end();
}
