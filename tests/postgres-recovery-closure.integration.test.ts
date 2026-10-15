import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresWorkflowRepository } from "../modules/workflow/postgres-workflow-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(databaseUrl !== undefined)(
  "Postgres recovery queue closure",
  () => {
    it("closes all eligible rows atomically and preserves completed timestamps and error evidence", async () => {
      const schema = `recovery_${randomUUID().replaceAll("-", "")}`;
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      let repository: PostgresWorkflowRepository | undefined;
      try {
        // Isolate the global operation from other integration tests' executions.
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(`CREATE TABLE ${schema}.workflow_executions (
        id integer PRIMARY KEY, status text NOT NULL, current_node_id text,
        next_retry_at timestamptz, completed_at timestamptz, error_code text
      )`);
        await client.query(`INSERT INTO ${schema}.workflow_executions
        SELECT n, CASE WHEN n <= 12 THEN 'retrying' WHEN n = 13 THEN 'failed'
          WHEN n = 14 THEN 'dead-lettered' WHEN n = 15 THEN 'running'
          WHEN n = 16 THEN 'succeeded' ELSE 'closed' END,
          'fictional-node', NOW(), CASE WHEN n = 13 THEN '2026-01-01T00:00:00Z'::timestamptz ELSE NULL END,
          'FICTIONAL_ERROR' FROM generate_series(1, 17) n`);
        const isolatedUrl = new URL(databaseUrl!);
        isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
        repository = new PostgresWorkflowRepository(isolatedUrl.toString());
        expect(await repository.closeRecoveryQueue()).toEqual({
          closedCount: 14,
        });
        expect(await repository.closeRecoveryQueue()).toEqual({
          closedCount: 0,
        });
        const result = await client.query<{
          status: string;
          completed_at: Date | null;
        }>(`SELECT * FROM ${schema}.workflow_executions ORDER BY id`);
        for (const row of result.rows.slice(0, 14)) {
          expect(row).toMatchObject({
            status: "closed",
            current_node_id: null,
            next_retry_at: null,
            error_code: "FICTIONAL_ERROR",
          });
          expect(row.completed_at).toBeInstanceOf(Date);
        }
        expect(result.rows[12]!.completed_at?.toISOString()).toBe(
          "2026-01-01T00:00:00.000Z",
        );
        expect(result.rows.slice(14).map((row) => row.status)).toEqual([
          "running",
          "succeeded",
          "closed",
        ]);
      } finally {
        await repository?.close();
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await client.end();
      }
    });
  },
);
