import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresImageInputSettingsRepository } from "../modules/ai/postgres-image-input-settings-repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(testDatabaseUrl !== undefined)(
  "PostgresImageInputSettingsRepository",
  () => {
    let repository: PostgresImageInputSettingsRepository;
    let inspectionPool: Pool;

    beforeAll(() => {
      repository = new PostgresImageInputSettingsRepository(
        testDatabaseUrl ?? "",
      );
      inspectionPool = new Pool({ connectionString: testDatabaseUrl });
    });

    beforeEach(async () => {
      await inspectionPool.query("DELETE FROM ai_image_input_settings");
    });

    afterAll(async () => {
      await Promise.all([repository.close(), inspectionPool.end()]);
    });

    it("persists singleton image settings with optimistic concurrency", async () => {
      await expect(repository.isReady()).resolves.toBe(true);
      await expect(repository.find()).resolves.toBeNull();

      const created = await repository.save({
        enabled: true,
        includeAttachments: true,
        includeLinkPreviewImages: true,
        trustedLinkPreviewHosts: ["images.example.test"],
        maxCurrentAttachments: 3,
        maxHistoryImages: 2,
        maxTotalImages: 5,
        maxImageBytes: 5_242_880,
        maxTotalBytes: 15_728_640,
        fetchTimeoutMs: 12_000,
        detail: "auto",
        expectedVersion: 0,
      });
      expect(created).toMatchObject({
        status: "ok",
        value: {
          enabled: true,
          detail: "auto",
          trustedLinkPreviewHosts: ["images.example.test"],
          version: 1,
        },
      });

      await expect(
        repository.save({
          enabled: false,
          includeAttachments: true,
          includeLinkPreviewImages: true,
          trustedLinkPreviewHosts: [],
          maxCurrentAttachments: 4,
          maxHistoryImages: 2,
          maxTotalImages: 6,
          maxImageBytes: 10_485_760,
          maxTotalBytes: 20_971_520,
          fetchTimeoutMs: 15_000,
          detail: "high",
          expectedVersion: 0,
        }),
      ).resolves.toEqual({ status: "conflict" });

      await expect(repository.find()).resolves.toMatchObject({
        enabled: true,
        maxTotalImages: 5,
        version: 1,
      });
    });
  },
);
