import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresWebSearchSettingsRepository } from "../modules/ai/postgres-web-search-settings-repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(testDatabaseUrl !== undefined)(
  "PostgresWebSearchSettingsRepository",
  () => {
    let repository: PostgresWebSearchSettingsRepository;
    let inspectionPool: Pool;

    beforeAll(() => {
      repository = new PostgresWebSearchSettingsRepository(
        testDatabaseUrl ?? "",
      );
      inspectionPool = new Pool({ connectionString: testDatabaseUrl });
    });

    beforeEach(async () => {
      await inspectionPool.query("DELETE FROM ai_web_search_settings");
    });

    afterAll(async () => {
      await Promise.all([repository.close(), inspectionPool.end()]);
    });

    it("persists the singleton settings row with optimistic concurrency", async () => {
      await expect(repository.isReady()).resolves.toBe(true);
      await expect(repository.find()).resolves.toBeNull();

      const created = await repository.save({
        maxAttempts: 3,
        attemptTimeoutMs: 10_000,
        retryDelayMs: 500,
        maxResults: 8,
        failurePolicy: "continue",
        expectedVersion: 0,
      });
      expect(created).toMatchObject({
        status: "ok",
        value: {
          maxAttempts: 3,
          maxResults: 8,
          failurePolicy: "continue",
          version: 1,
        },
      });

      await expect(
        repository.save({
          maxAttempts: 2,
          attemptTimeoutMs: 8_000,
          retryDelayMs: 300,
          maxResults: 5,
          failurePolicy: "mode-default",
          expectedVersion: 0,
        }),
      ).resolves.toEqual({ status: "conflict" });

      const updated = await repository.save({
        maxAttempts: 2,
        attemptTimeoutMs: 8_000,
        retryDelayMs: 300,
        maxResults: 5,
        failurePolicy: "fail",
        expectedVersion: 1,
      });
      expect(updated).toMatchObject({
        status: "ok",
        value: { failurePolicy: "fail", version: 2 },
      });
      await expect(repository.find()).resolves.toMatchObject({
        failurePolicy: "fail",
        version: 2,
      });
    });
  },
);
