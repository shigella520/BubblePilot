import { describe, expect, it } from "vitest";
import { executionTiming } from "../modules/workflow/execution-timing.js";
import {
  executionDurationLabel,
  formatExecutionDuration,
} from "../apps/web/src/utils/execution-timing.js";

const observed = new Date("2026-01-01T00:01:00Z");
const base = {
  status: "succeeded",
  startedAt: "2026-01-01T00:00:00Z",
  completedAt: "2026-01-01T00:00:38.600Z",
};
describe("execution timing semantics", () => {
  it("keeps wall time separate from overlapping cumulative durations and missing traces", () => {
    const t = executionTiming(
      base,
      {
        model: { durationMs: 40000, count: 2, recordedCount: 2 },
        tools: { durationMs: 9000, count: 1, recordedCount: 1 },
      },
      observed,
    );
    expect(t.totalMs).toBe(38600);
    expect(t.categories.model.durationMs).toBe(40000);
    expect(t.categories.delivery.durationMs).toBeNull();
    expect(
      executionTiming(
        base,
        { delivery: { durationMs: 0, count: 1, recordedCount: 1 } },
        observed,
      ).categories.delivery.durationMs,
    ).toBe(0);
  });
  it("uses observation time only for running/retrying records, never creation or closure time", () => {
    expect(
      executionTiming(
        { ...base, status: "running", completedAt: null },
        {},
        observed,
      ),
    ).toMatchObject({ totalMs: 60000, totalState: "running" });
    expect(
      executionTiming(
        { ...base, status: "retrying", completedAt: null },
        {},
        observed,
      ),
    ).toMatchObject({ totalMs: 60000, totalState: "retrying" });
    for (const record of [
      { ...base, status: "closed" },
      { ...base, startupClosure: { previousStatus: "running" } },
    ])
      expect(executionTiming(record, {}, observed)).toMatchObject({
        totalMs: null,
        unavailableReason: "closed",
      });
    for (const record of [
      { ...base, startedAt: null },
      { ...base, startedAt: "invalid" },
      { ...base, completedAt: null },
      { ...base, completedAt: "2025-01-01T00:00:00Z" },
    ])
      expect(executionTiming(record, {}, observed).totalMs).toBeNull();
  });
  it("formats missing and zero independently and uses appropriate units", () => {
    expect([null, undefined, -1, NaN].map(formatExecutionDuration)).toEqual([
      "—",
      "—",
      "—",
      "—",
    ]);
    expect(
      [0, 800, 38600, 61000, 3660000].map(formatExecutionDuration),
    ).toEqual(["0 毫秒", "800 毫秒", "38.6 秒", "1 分 1 秒", "1 小时 1 分"]);
    expect(
      executionDurationLabel(
        executionTiming({ ...base, status: "closed" }, {}, observed),
      ),
    ).toContain("不计");
  });
});
