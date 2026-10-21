import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { NetworkSettings } from "../modules/shared/network-settings.js";
const url = process.env.TEST_DATABASE_URL;
describe.runIf(url)("shared network settings upgrade", () => {
  it.each([
    { hosts: [] },
    { hosts: ["images.example.test", "git.example.test"] },
  ])(
    "migrates legacy hosts %j once and isolates concurrent edits",
    async ({ hosts }) => {
      const admin = new Pool({ connectionString: url });
      const name = `network_${randomUUID().replaceAll("-", "")}_test`;
      let pool: Pool | undefined;
      let settings: NetworkSettings | undefined;
      try {
        await admin.query(`CREATE DATABASE "${name}"`);
        const target = new URL(url!);
        target.pathname = `/${name}`;
        pool = new Pool({ connectionString: target.href });
        await pool.query(
          "CREATE TABLE ai_image_input_settings(id integer PRIMARY KEY, trusted_link_preview_hosts jsonb)",
        );
        if (hosts.length)
          await pool.query(
            "INSERT INTO ai_image_input_settings VALUES(1,$1::jsonb)",
            [JSON.stringify(hosts)],
          );
        await pool.query(
          await readFile(
            new URL(
              "../migrations/0058_shared_network_settings.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        settings = new NetworkSettings(target.href);
        expect((await settings.view()).trustedFakeIpHosts).toEqual(hosts);
        const results = await Promise.all([
          settings.update({
            trustedFakeIpHosts: ["new.example.test"],
            expectedVersion: 1,
          }),
          settings.update({
            trustedFakeIpHosts: ["other.example.test"],
            expectedVersion: 1,
          }),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect((await settings.view()).version).toBe(2);
        await pool.query("DELETE FROM ai_image_input_settings");
        expect((await settings.view()).trustedFakeIpHosts).toEqual(
          results.find(Boolean)!.trustedFakeIpHosts,
        );
      } finally {
        await settings?.close();
        await pool?.end();
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.end();
      }
    },
  );
});
