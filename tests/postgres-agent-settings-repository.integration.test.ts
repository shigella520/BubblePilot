import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAgentSettingsRepository } from "../modules/ai/postgres-agent-settings-repository.js";
import { AgentSettingsService } from "../modules/ai/agent-settings-service.js";
import { defaultAgentSettings } from "../modules/ai/agent-settings-types.js";
const url = process.env.TEST_DATABASE_URL;
describe.runIf(url)("PostgresAgentSettingsRepository", () => {
  const repository = new PostgresAgentSettingsRepository(url ?? "");
  const pool = new Pool({ connectionString: url });
  beforeAll(async () => {
    await pool.query("DELETE FROM ai_agent_settings");
  });
  afterAll(async () => {
    await repository.close();
    await pool.end();
  });
  it("persists defaults, rejects concurrent saves and enforces database bounds", async () => {
    const service = new AgentSettingsService(repository);
    expect(await repository.isReady()).toBe(true);
    expect(await service.view()).toMatchObject({
      ...defaultAgentSettings,
      version: 0,
      source: "defaults",
    });
    const saves = await Promise.all([
      service.update({ ...defaultAgentSettings, expectedVersion: 0 }),
      service.update({ ...defaultAgentSettings, expectedVersion: 0 }),
    ]);
    expect(saves.map((s) => s.status).sort()).toEqual(["conflict", "ok"]);
    expect(
      await service.update({
        ...defaultAgentSettings,
        maxToolCalls: 16,
        expectedVersion: 1,
      }),
    ).toMatchObject({ status: "ok", value: { version: 2, maxToolCalls: 16 } });
    expect(await service.view()).toMatchObject({
      version: 2,
      maxToolCalls: 16,
      source: "database",
    });
    await expect(
      pool.query("UPDATE ai_agent_settings SET max_tool_calls=31"),
    ).rejects.toThrow();
  });
});
