import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresSummarySettingsRepository } from "../modules/workflow/postgres-summary-settings-repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(testDatabaseUrl !== undefined)(
  "PostgresSummarySettingsRepository",
  () => {
    let repository: PostgresSummarySettingsRepository;
    let inspectionPool: Pool;

    beforeAll(() => {
      repository = new PostgresSummarySettingsRepository(testDatabaseUrl ?? "");
      inspectionPool = new Pool({ connectionString: testDatabaseUrl });
    });

    beforeEach(async () => {
      await inspectionPool.query("DELETE FROM conversation_summary_settings");
    });

    afterAll(async () => {
      await Promise.all([repository.close(), inspectionPool.end()]);
    });

    it("updates runtime configuration without creating a new summary policy", async () => {
      const created = await repository.save({
        enabled: false,
        includeFromMe: true,
        baseMessageWindow: 4,
        characterLimit: 6_000,
        redundancyMessageWindow: 3,
        providerRouteId: "",
        timeZone: "UTC",
        expectedVersion: 0,
      });
      expect(created).toMatchObject({
        status: "ok",
        value: { version: 1, policyVersion: 1 },
      });

      const updated = await repository.save({
        enabled: false,
        includeFromMe: true,
        baseMessageWindow: 8,
        characterLimit: 8_000,
        redundancyMessageWindow: 5,
        providerRouteId: "",
        timeZone: "Asia/Shanghai",
        expectedVersion: 1,
      });
      expect(updated).toMatchObject({
        status: "ok",
        value: {
          version: 2,
          policyVersion: 1,
          baseMessageWindow: 8,
          redundancyMessageWindow: 5,
        },
      });
    });
  },
);
