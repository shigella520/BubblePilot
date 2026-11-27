import { ApiError, errorMessage } from "../services/api";
import { formatDateTime } from "./format";
import {
  embeddingErrorLabel,
  embeddingFailureSummary,
} from "./memory-tool-diagnostics";

/**
 * Long-term retrieval health shared by the chat list, the chat dialog and the
 * AI service overview (doc/迭代需求-长期检索易用性整改.md §3).
 */
export type MemoryHealthState =
  | "disabled"
  | "global-off"
  | "rebuild-required"
  | "indexing"
  | "service-error"
  | "missing"
  | "healthy";
export interface MemoryChatHealth {
  chatId: string;
  enabled: boolean;
  state: MemoryHealthState;
  total: number;
  indexed: number;
  missing: number;
  progress: { total: number; done: number; percent: number } | null;
  retryAt: string | null;
  error: {
    code: string;
    detail: Record<string, unknown> | null;
    at: string | null;
  } | null;
}
export interface MemoryHealthView {
  globalEnabled: boolean;
  generation: {
    id: string;
    model: string;
    dimensions: number;
    precision: string;
  } | null;
  chats: MemoryChatHealth[];
}
export const memoryHealthPath = "/api/v1/memory/health";

/** Health of one chat; chats without memory settings read as 未启用. */
export function chatHealth(
  view: MemoryHealthView | null,
  chatId: string,
): MemoryChatHealth | null {
  if (!view) return null;
  return (
    view.chats.find((c) => c.chatId === chatId) ?? {
      chatId,
      enabled: false,
      state: "disabled",
      total: 0,
      indexed: 0,
      missing: 0,
      progress: null,
      retryAt: null,
      error: null,
    }
  );
}

const repairable = new Set<MemoryHealthState>([
  "missing",
  "service-error",
  "rebuild-required",
]);
export function isRepairable(health: MemoryChatHealth | null | undefined) {
  return !!health && repairable.has(health.state);
}

/** Short cell text: 正常 / 缺失 128 条 / 索引中 42% / 服务异常 … */
export function healthShortText(health: MemoryChatHealth | null | undefined) {
  if (!health) return "状态未知";
  switch (health.state) {
    case "healthy":
      return "正常";
    case "missing":
      return `缺失 ${health.missing} 条`;
    case "indexing":
      return health.progress ? `索引中 ${health.progress.percent}%` : "索引中";
    case "service-error":
      return "服务异常";
    case "rebuild-required":
      return "需重建";
    case "global-off":
      return "全局已关闭";
    default:
      return "未启用";
  }
}

/** Chinese name of an index / embedding error code. */
export const memoryErrorName = embeddingErrorLabel;

/** "向量服务响应超时（超时 · 上游请求 ID …）" for a health or job error. */
export function memoryErrorText(
  code: string,
  detail: unknown,
  at?: string | null,
) {
  const summary = embeddingFailureSummary(detail);
  return `${memoryErrorName(code)}${summary ? `（${summary}）` : ""}${
    at ? ` · ${formatDateTime(at)}` : ""
  }`;
}

/** Hover text: latest error with upstream request id and next retry. */
export function healthTitle(health: MemoryChatHealth | null | undefined) {
  if (!health) return "长期检索状态暂不可用";
  const parts = [healthShortText(health)];
  if (health.state === "indexing" && health.progress)
    parts.push(`已处理 ${health.progress.done} / ${health.progress.total} 条`);
  if (health.error)
    parts.push(
      `最近错误：${memoryErrorText(health.error.code, health.error.detail, health.error.at)}`,
    );
  if (health.retryAt)
    parts.push(`下次自动重试：${formatDateTime(health.retryAt)}`);
  return parts.join("\n");
}

/** Readable outcome of POST …/memory/repair. */
export function repairNotice(result: {
  action: "backfill" | "rebuild";
  jobIds: string[];
}) {
  if (result.action === "rebuild")
    return "归属重建已启动，完成后会自动补齐索引。";
  return result.jobIds.length
    ? "已开始补全缺失的索引，可在「最近任务」查看进度。"
    : "没有需要补全的缺口。";
}

/** A still-failing embedding service is reported as such, not as a conflict. */
export function repairErrorMessage(cause: unknown) {
  const text = errorMessage(cause);
  return cause instanceof ApiError &&
    /^MEMORY_(EMBEDDING|MODEL)_/u.test(cause.code)
    ? `服务仍不可用，未创建修复任务，请检查向量服务后再试。\n${text}`
    : text;
}

/** Dimension the service returned when a probe failed with a mismatch. */
export function returnedDimensions(cause: unknown): number | null {
  if (
    !(cause instanceof ApiError) ||
    cause.code !== "MEMORY_EMBEDDING_DIMENSION_MISMATCH"
  )
    return null;
  const match = /返回 (\d+) 维/u.exec(cause.message);
  return match ? Number(match[1]) : null;
}

/** pgvector index limits (mirrors embeddingPrecisionLimits on the server). */
export const precisionLimits = { float32: 2000, float16: 4000 } as const;
export type EmbeddingPrecision = keyof typeof precisionLimits;
export function precisionLimit(precision: string | null | undefined) {
  return precision === "float16"
    ? precisionLimits.float16
    : precisionLimits.float32;
}

export interface MemoryJob {
  reason: string;
  id: string;
  created_at: string;
  updated_at: string;
  attempts: number;
  chat_id: string;
  generation_id: string;
  status: string;
  version: number;
  cursor_index: string;
  through_index: string;
  error_code: string | null;
  error_detail?: Record<string, unknown> | null;
  request_key: string | null;
  chat_name: string | null;
  model: string;
  range_from: string | null;
  range_to: string | null;
  /** Automatic retries after upstream failures; > 0 while 等待重试. */
  auto_retries?: number;
  next_attempt_at?: string | null;
  progress?: {
    scope: string | null;
    total: number;
    processed: number;
    removed: number;
    remaining: number;
    percent: number | null;
    lastProgressAt: string | null;
    generatedAt: string;
    estimate: {
      status: string;
      messagesPerMinute: number | null;
      remainingSeconds: number | null;
      estimatedCompletionAt: string | null;
    };
  };
}
export type MemoryJobKind = "backfill" | "rebuild" | "incremental";
export function memoryJobKind(job: MemoryJob): MemoryJobKind {
  if (job.reason === "rebuild") return "rebuild";
  return job.request_key || job.reason !== "incremental"
    ? "backfill"
    : "incremental";
}
/** Status shown to the operator; queued after upstream failures reads 等待重试. */
export function memoryJobStatus(job: MemoryJob) {
  if (job.status === "queued" && (job.auto_retries ?? 0) > 0)
    return "waiting-retry";
  if (
    job.status === "queued" &&
    ["available", "warming", "stalled"].includes(
      job.progress?.estimate.status ?? "",
    )
  )
    return "running";
  return job.status;
}
/** Shown by default; plain 新消息 jobs are collapsed into a summary. */
export function isProminentJob(job: MemoryJob) {
  return (
    memoryJobKind(job) !== "incremental" ||
    ["failed", "waiting-retry", "running"].includes(memoryJobStatus(job))
  );
}
