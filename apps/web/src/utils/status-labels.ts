/**
 * One place that turns backend enums into Chinese labels and semantic tones,
 * so the same state reads and looks the same on every page.
 */
export type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";
export interface StatusLabel {
  label: string;
  tone: StatusTone;
}

const domains = {
  execution: {
    created: { label: "已创建", tone: "neutral" },
    running: { label: "运行中", tone: "info" },
    retrying: { label: "重试中", tone: "warning" },
    succeeded: { label: "成功", tone: "success" },
    skipped: { label: "已跳过", tone: "neutral" },
    failed: { label: "失败", tone: "danger" },
    "dead-lettered": { label: "重试耗尽", tone: "danger" },
    closed: { label: "已关闭", tone: "neutral" },
  },
  workflow: {
    draft: { label: "草稿", tone: "neutral" },
    active: { label: "已启用", tone: "success" },
    inactive: { label: "已停用", tone: "neutral" },
  },
  memoryJob: {
    queued: { label: "排队中", tone: "neutral" },
    running: { label: "处理中", tone: "info" },
    paused: { label: "已暂停", tone: "warning" },
    succeeded: { label: "已完成", tone: "success" },
    failed: { label: "失败", tone: "danger" },
    cancelled: { label: "已取消", tone: "neutral" },
    superseded: { label: "已被替代", tone: "neutral" },
  },
  dataExport: {
    "awaiting-confirmation": { label: "待确认", tone: "warning" },
    ready: { label: "可下载", tone: "success" },
    revoked: { label: "已撤销", tone: "neutral" },
    expired: { label: "已过期", tone: "neutral" },
  },
  health: {
    healthy: { label: "正常", tone: "success" },
    degraded: { label: "降级", tone: "warning" },
    "half-open": { label: "试探恢复", tone: "warning" },
    open: { label: "熔断", tone: "danger" },
    unknown: { label: "未知", tone: "neutral" },
  },
} satisfies Record<string, Record<string, StatusLabel>>;

export type StatusDomain = keyof typeof domains;

/** Unknown values stay visible as-is with a neutral tone. */
export function statusLabel(
  domain: StatusDomain,
  status: string | null | undefined,
): StatusLabel {
  const value = status ?? "";
  const known = (domains[domain] as Record<string, StatusLabel>)[value];
  return known ?? { label: value || "—", tone: "neutral" };
}
