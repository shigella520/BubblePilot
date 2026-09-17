import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresContextSettingsRepository } from "../modules/workflow/postgres-context-settings-repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(testDatabaseUrl !== undefined)(
  "PostgresContextSettingsRepository",
  () => {
    let repository: PostgresContextSettingsRepository;
    let inspectionPool: Pool;

    beforeAll(() => {
      repository = new PostgresContextSettingsRepository(testDatabaseUrl ?? "");
      inspectionPool = new Pool({ connectionString: testDatabaseUrl });
    });

    beforeEach(async () => {
      await inspectionPool.query("DELETE FROM conversation_context_settings");
    });

    afterAll(async () => {
      await Promise.all([repository.close(), inspectionPool.end()]);
    });

    it("updates runtime configuration without creating a new summary policy", async () => {
      const created = await repository.save({
        includeFromMe: true,
        baseMessageWindow: 4,
        characterLimit: 6_000,
        redundancyMessageWindow: 3,
        expectedVersion: 0,
      });
      expect(created).toMatchObject({
        status: "ok",
        value: { version: 1 },
      });

      const updated = await repository.save({
        includeFromMe: true,
        baseMessageWindow: 8,
        characterLimit: 8_000,
        redundancyMessageWindow: 5,
        expectedVersion: 1,
      });
      expect(updated).toMatchObject({
        status: "ok",
        value: {
          version: 2,
          baseMessageWindow: 8,
          redundancyMessageWindow: 5,
        },
      });
    });
    it("allows only one concurrent writer and rejects stale saves", async () => {
      const input = {
        includeFromMe: true,
        baseMessageWindow: 10,
        redundancyMessageWindow: 10,
        characterLimit: 6000,
        expectedVersion: 0,
      };
      const writes = await Promise.all([
        repository.save(input),
        repository.save(input),
      ]);
      expect(writes.map((r) => r.status).sort()).toEqual(["conflict", "ok"]);
      const current = await repository.find();
      expect(current?.version).toBe(1);
      expect(await repository.save({ ...input, expectedVersion: 2 })).toEqual({
        status: "conflict",
      });
    });
  },
);
