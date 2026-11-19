import type { ExecutionTiming } from "../../../../modules/workflow/execution-timing.js";
export type { ExecutionTiming };

export function formatExecutionDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.floor(ms)} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const seconds = Math.floor(ms / 1000);
  return seconds < 3600
    ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
    : `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}
export function executionDurationLabel(timing?: ExecutionTiming): string {
  if (timing?.unavailableReason === "closed") return "已关闭 · 总耗时不计";
  if (timing?.totalState === "running") return "已运行";
  if (timing?.totalState === "retrying") return "重试中 · 已历时";
  return "总计";
}
