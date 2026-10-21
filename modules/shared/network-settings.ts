import { isIP } from "node:net";
import { z } from "zod";
import { createPostgresPool } from "./postgres-pool.js";

export const trustedFakeIpHostsSchema = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .max(253)
      .refine(
        (host) => isIP(host) === 0,
        "Use a DNS hostname, not an IP address.",
      )
      .regex(
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
      ),
  )
  .max(32)
  .transform((hosts) => [...new Set(hosts)]);
export const networkSettingsUpdateSchema = z.object({
  trustedFakeIpHosts: trustedFakeIpHostsSchema,
  expectedVersion: z.number().int().min(1),
});
export type TrustedHostsProvider = () => Promise<readonly string[]>;
export interface NetworkSettingsView {
  trustedFakeIpHosts: string[];
  version: number;
  updatedAt: string;
}
interface SettingsRow {
  trusted_fake_ip_hosts: string[];
  version: number;
  updated_at: Date;
}
export class NetworkSettings {
  private readonly pool;
  constructor(databaseUrl: string, queryTimeoutMs?: number) {
    this.pool = createPostgresPool(databaseUrl, 3, queryTimeoutMs);
  }
  private record(row: {
    trusted_fake_ip_hosts: string[];
    version: number;
    updated_at: Date;
  }): NetworkSettingsView {
    return {
      trustedFakeIpHosts: row.trusted_fake_ip_hosts,
      version: row.version,
      updatedAt: row.updated_at.toISOString(),
    };
  }
  async view(): Promise<NetworkSettingsView> {
    const result = await this.pool.query<SettingsRow>(
      "SELECT * FROM network_settings WHERE id=1",
    );
    if (!result.rows[0]) throw new Error("NETWORK_SETTINGS_UNAVAILABLE");
    return this.record(result.rows[0]);
  }
  readonly trustedHosts: TrustedHostsProvider = async () =>
    (await this.view()).trustedFakeIpHosts;
  async update(
    input: z.infer<typeof networkSettingsUpdateSchema>,
  ): Promise<NetworkSettingsView | null> {
    const result = await this.pool.query<SettingsRow>(
      "UPDATE network_settings SET trusted_fake_ip_hosts=$1::jsonb,version=version+1,updated_at=now() WHERE id=1 AND version=$2 RETURNING *",
      [JSON.stringify(input.trustedFakeIpHosts), input.expectedVersion],
    );
    return result.rows[0] ? this.record(result.rows[0]) : null;
  }
  async close() {
    await this.pool.end();
  }
}
