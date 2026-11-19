export type ExecutionTimingCategory =
  "model" | "tools" | "delivery" | "otherNodes";
export interface ExecutionTimingBucket {
  durationMs: number | null;
  count: number;
  recordedCount: number;
}
export interface ExecutionTiming {
  observedAt: string;
  totalMs: number | null;
  totalState: "finished" | "running" | "retrying" | "unavailable";
  unavailableReason: "closed" | "missing" | null;
  categories: Record<ExecutionTimingCategory, ExecutionTimingBucket>;
}

/** Wall time and cumulative trace durations are deliberately separate metrics. */
export function executionTiming(
  execution: {
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    startupClosure?: unknown;
  },
  categories: Partial<ExecutionTiming["categories"]>,
  observedAt: Date,
): ExecutionTiming {
  const result: ExecutionTiming = {
    observedAt: observedAt.toISOString(),
    totalMs: null,
    totalState: "unavailable",
    unavailableReason: "missing",
    categories: Object.fromEntries(
      (["model", "tools", "delivery", "otherNodes"] as const).map((key) => [
        key,
        categories[key] ?? { durationMs: null, count: 0, recordedCount: 0 },
      ]),
    ) as ExecutionTiming["categories"],
  };
  if (execution.startupClosure || execution.status === "closed") {
    result.unavailableReason = "closed";
    return result;
  }
  const active =
    execution.status === "running" || execution.status === "retrying";
  const start = execution.startedAt ? Date.parse(execution.startedAt) : NaN;
  const end = active
    ? observedAt.getTime()
    : execution.completedAt
      ? Date.parse(execution.completedAt)
      : NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    result.totalMs = end - start;
    result.totalState =
      execution.status === "retrying"
        ? "retrying"
        : active
          ? "running"
          : "finished";
    result.unavailableReason = null;
  }
  return result;
}
