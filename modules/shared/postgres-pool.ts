import { Pool } from "pg";

export const defaultDatabaseQueryTimeoutMs = 30_000;

export function createPostgresPool(
  databaseUrl: string,
  max: number,
  queryTimeoutMs = defaultDatabaseQueryTimeoutMs,
): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max,
    connectionTimeoutMillis: queryTimeoutMs,
    query_timeout: queryTimeoutMs,
    statement_timeout: queryTimeoutMs,
  });
}
