import { describe, expect, it, vi } from "vitest";
import {
  DataHousekeeping,
  housekeepingSteps,
} from "../modules/maintenance/data-housekeeping.js";

describe("data housekeeping", () => {
  it("runs every bounded step and isolates failures", async () => {
    const query = vi.fn((sql: string) =>
      sql.includes("bot_attribution_jobs")
        ? Promise.reject(new Error("fictional outage"))
        : Promise.resolve({ rowCount: sql.includes("memory_chunks") ? 3 : 0 }),
    );
    const report = vi.fn();
    const results = await new DataHousekeeping(
      { query } as never,
      report,
    ).runOnce();
    expect(query).toHaveBeenCalledTimes(housekeepingSteps.length);
    expect(results).toContainEqual({ step: "invalid-memory-chunks", rows: 3 });
    expect(results).toContainEqual({
      step: "finished-attribution-jobs",
      rows: -1,
    });
    expect(report).toHaveBeenCalledWith(results);
    // Every statement is bounded so one run never locks a large table.
    for (const { sql } of housekeepingSteps) expect(sql).toMatch(/LIMIT \d+/u);
  });
});
