<script setup lang="ts">
import AgentBudgetDetails from "../components/AgentBudgetDetails.vue";
import MemorySources from "../components/MemorySources.vue";
import MemoryPanel from "../components/MemoryPanel.vue";
import {
  FileClock,
  Image,
  ClipboardCopy,
  FileJson,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Route,
  Search,
  ShieldCheck,
  X,
  XCircle,
} from "@lucide/vue";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { useRoute } from "vue-router";

import CursorPagination from "../components/CursorPagination.vue";
import SensitiveUnlock from "../components/SensitiveUnlock.vue";
import DismissibleMessage from "../components/DismissibleMessage.vue";
import AiUsageChart from "../components/AiUsageChart.vue";
import { useCursorPager } from "../composables/useCursorPager";
import { apiPageRequest, apiRequest, errorMessage } from "../services/api";
import { useSessionStore } from "../stores/session";

interface Execution {
  id: string;
  providerChatId: string | null;
  chatDisplayName: string | null;
  workflowName: string;
  workflowVersion: number;
  triggerName: string;
  status: string;
  retryOfExecutionId: string | null;
  recoveryAttempt: number;
  currentNodeId: string | null;
  errorCode: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  completedAt: string | null;
  cachedPromptTokens: number | null;
  cacheEligiblePromptTokens: number;
  cacheHitRate: number | null;
  contextSnapshot: Record<string, unknown> | null;
  botIdentity?: {
    workflowId: string;
    nickname: string | null;
    version: number;
  } | null;
}
interface AiRouteTrace {
  id: string;
  routeId: string;
  routeName: string | null;
  routeVersion: number | null;
  agentTurn: number;
  phase: "standard" | "image-original" | "image-degraded";
  requestRequirements: {
    hasImages: boolean;
    allowImageDegrade: boolean;
    requiresTools: boolean;
    webSearch: string | null;
  };
  fallbackEnabled: boolean | null;
  maxRounds: number | null;
  candidateDecisions: Array<{
    providerId: string;
    providerName: string | null;
    providerVersion: number | null;
    model: string | null;
    configuredPosition: number;
    round: number | null;
    sequence: number | null;
    decision: "eligible" | "excluded" | "skipped" | "attempted";
    reason: string;
    healthState: string | null;
    imageInputConfigured: boolean | null;
    imageInputProbe: string | null;
  }>;
  terminalStatus: "succeeded" | "failed";
  terminalCode: string | null;
  durationMs: number;
  createdAt: string;
}
interface ExecutionDetail extends Execution {
  correlationId: string;
  nodes: Array<{
    id: string;
    nodeId: string;
    nodeType: string;
    attempt: number;
    status: string;
    durationMs: number | null;
    errorCode: string | null;
    inputSummary: unknown;
    outputSummary: unknown;
  }>;
  deliveries: Array<{
    id: string;
    nodeId: string;
    status: string;
    attemptCount: number;
    errorCode: string | null;
  }>;
  aiProviderAttempts: Array<{
    id: string;
    purpose: "workflow-reply" | "image-summary";
    routeTraceId: string | null;
    routePhase: AiRouteTrace["phase"];
    nodeId: string;
    routeId: string;
    routeVersion: number;
    providerId: string;
    providerName: string;
    providerVersion: number;
    model: string;
    agentTurn: number;
    round: number;
    sequence: number;
    status: string;
    selectionHealthState: string;
    healthState: string;
    durationMs: number;
    errorCategory: string | null;
    errorCode: string | null;
    retryable: boolean | null;
    fallbackAllowed: boolean | null;
    rawResponse?: { status: "available" | "unavailable" };
    rawRequest: { status: "available" | "unavailable" };
    diagnostics: {
      clientRequestId: string | null;
      providerRequestId: string | null;
      httpStatus: number | null;
      requestHash: string;
      requestMessageCount: number;
      requestCharacters: number;
      responseBytes: number | null;
      responseBodyHash: string | null;
      responseFinishReason: string | null;
      responseContentCharacters: number | null;
      responseReasoningCharacters: number | null;
      promptTokens: number | null;
      completionTokens: number | null;
      reasoningTokens: number | null;
      totalTokens: number | null;
      cachedPromptTokens: number | null;
      cacheWritePromptTokens: number | null;
      cacheMissPromptTokens: number | null;
      requestTrace?: {
        traceKeyHash: string;
        apiKind: "chat-completions" | "responses";
        requestHash: string;
        configurationHash: string;
        previousRequestHash: string | null;
        previousItemCount: number | null;
        sharedPrefixItemCount: number | null;
        configurationMatchesPrevious: boolean | null;
        previousRequestIsExactPrefix: boolean | null;
        cacheKeyHash: string | null;
        cacheKeyMatchesPrevious: boolean | null;
        divergenceIndex: number | null;
        divergenceRegion: string | null;
        divergenceReason: string | null;
        items: Array<{
          index: number;
          role: string;
          contentKinds: string[];
          textCharacters: number;
          imageCount: number;
          imageBytes: number;
          historyMessageIdHash?: string | null;
          textHash?: string;
          imageContentHash?: string | null;
          linkPreviewHash?: string | null;
          itemHash: string;
          prefixHash: string;
          region: string;
        }>;
      } | null;
    } | null;
  }>;
  aiRouteTraces: AiRouteTrace[];
  aiToolExecutions: Array<{
    id: string;
    nodeId: string;
    providerId: string;
    toolCallId: string;
    toolName: string;
    status: string;
    durationMs: number;
    resultCount: number | null;
    queryHash: string;
    errorCode: string | null;
    requestDetails: Record<string, unknown> | null;
    responseDetails: Record<string, unknown> | null;
    createdAt: string;
  }>;
  aiImageInputs: Array<{
    id: string;
    nodeId: string;
    source: "attachment" | "link-preview";
    sourceHash: string;
    hostName: string | null;
    status: "succeeded" | "skipped" | "failed";
    declaredMimeType: string | null;
    actualMimeType: string | null;
    bytes: number | null;
    durationMs: number;
    detail: "low" | "high" | "auto";
    errorCode: string | null;
    createdAt: string;
  }>;
}
interface AuditEvent {
  id: string;
  actorType: string;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: string;
  correlationId: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

interface AiUsageMetrics {
  requestCount: number;
  succeededRequestCount: number;
  failedRequestCount: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cachedPromptTokens: number | null;
  cacheEligiblePromptTokens: number;
  cacheHitRate: number | null;
  cacheDataCoverage: number | null;
}

interface AiUsagePeriodRow {
  providerId: string;
  providerName: string;
  today: AiUsageMetrics;
  week: AiUsageMetrics;
  month: AiUsageMetrics;
}

interface AiUsageReport {
  generatedAt: string;
  timeZone: string;
  hours: 1 | 6 | 12 | 24 | 48;
  bucketMinutes: 1 | 5 | 15 | 30;
  providers: Array<{ id: string; name: string }>;
  periods: AiUsagePeriodRow[];
  series: Array<{
    bucketStart: string;
    providers: Array<{ providerId: string } & AiUsageMetrics>;
  }>;
}

const detail = ref<ExecutionDetail | null>(null);
interface RawResponse {
  body: string;
  bytes: number;
  truncated: boolean;
  httpStatus: number;
  error: Record<string, string>;
  requestIds: Record<string, string>;
}
const rawResponses = ref<Record<string, RawResponse>>({});
const responseLoadingId = ref<string | null>(null);
const rawRequests = ref<Record<string, string>>({});
const rawRequestLoadingId = ref<string | null>(null);
const message = ref("");
const messageIsError = ref(false);
const recoveryBusy = ref(false);
const recoveryOnly = ref(false);
const detailLoadingId = ref<string | null>(null);
const detailDialog = ref<HTMLElement | null>(null);
const usage = ref<AiUsageReport | null>(null);
const usageHours = ref<AiUsageReport["hours"]>(24);
const usageBusy = ref(false);
const usageError = ref("");
let inspectRequestId = 0;
let usageRequestId = 0;
let usageRefreshTimer: number | null = null;
let pageOverflowBeforeDetail = "";
let detailReturnFocus: HTMLElement | null = null;
let applicationRoot: HTMLElement | null = null;
let applicationRootWasInert = false;
const route = useRoute();
const session = useSessionStore();
const executionPager = useCursorPager<Execution>((cursor) => {
  const query = new URLSearchParams({ limit: "10" });
  if (recoveryOnly.value) {
    query.set("status", "retrying,failed,dead-lettered,closed");
  }
  if (cursor !== null) query.set("cursor", cursor);
  return apiPageRequest<Execution[]>(`/api/v1/executions?${query}`);
});
const auditPager = useCursorPager<AuditEvent>((cursor) => {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor !== null) query.set("cursor", cursor);
  return apiPageRequest<AuditEvent[]>(`/api/v1/audit-events?${query}`);
});
const executions = executionPager.items;
const audits = auditPager.items;
const busy = computed(
  () => executionPager.busy.value || auditPager.busy.value || usageBusy.value,
);
const usageColors = ["#6c8cff", "#20b486", "#f59e0b", "#e66a9c", "#8b5cf6"];
const usageProviders = computed(() =>
  (usage.value?.providers ?? []).map((provider, index) => ({
    ...provider,
    color: usageColors[index % usageColors.length] ?? "#6c8cff",
  })),
);
const usageHourOptions = [1, 6, 12, 24, 48] as const;

function combineUsageMetrics(items: AiUsageMetrics[]): AiUsageMetrics {
  const totals = items.reduce(
    (result, item) => ({
      requestCount: result.requestCount + item.requestCount,
      succeededRequestCount:
        result.succeededRequestCount + item.succeededRequestCount,
      failedRequestCount: result.failedRequestCount + item.failedRequestCount,
      promptTokens: result.promptTokens + item.promptTokens,
      completionTokens: result.completionTokens + item.completionTokens,
      reasoningTokens: result.reasoningTokens + item.reasoningTokens,
      totalTokens: result.totalTokens + item.totalTokens,
      cachedPromptTokens:
        result.cachedPromptTokens + (item.cachedPromptTokens ?? 0),
      cacheEligiblePromptTokens:
        result.cacheEligiblePromptTokens + item.cacheEligiblePromptTokens,
    }),
    {
      requestCount: 0,
      succeededRequestCount: 0,
      failedRequestCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      cachedPromptTokens: 0,
      cacheEligiblePromptTokens: 0,
    },
  );
  return {
    ...totals,
    cachedPromptTokens:
      totals.cacheEligiblePromptTokens === 0 ? null : totals.cachedPromptTokens,
    cacheHitRate:
      totals.cacheEligiblePromptTokens === 0
        ? null
        : totals.cachedPromptTokens / totals.cacheEligiblePromptTokens,
    cacheDataCoverage:
      totals.promptTokens === 0
        ? null
        : Math.min(1, totals.cacheEligiblePromptTokens / totals.promptTokens),
  };
}

const usagePeriodRows = computed<AiUsagePeriodRow[]>(() => {
  const rows = usage.value?.periods ?? [];
  if (rows.length === 0) return [];
  return [
    ...rows,
    {
      providerId: "all",
      providerName: "全部 Provider",
      today: combineUsageMetrics(rows.map((row) => row.today)),
      week: combineUsageMetrics(rows.map((row) => row.week)),
      month: combineUsageMetrics(rows.map((row) => row.month)),
    },
  ];
});
const hasRealtimeUsage = computed(
  () =>
    usage.value?.series.some((point) =>
      point.providers.some((provider) => provider.requestCount > 0),
    ) ?? false,
);

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCacheRate(value: number | null): string {
  return value === null ? "暂无数据" : `${(value * 100).toFixed(1)}%`;
}

function usageTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

async function loadUsage(): Promise<boolean> {
  if (!session.authenticated) {
    usage.value = null;
    return false;
  }
  const requestId = ++usageRequestId;
  usageBusy.value = true;
  usageError.value = "";
  try {
    const query = new URLSearchParams({
      hours: String(usageHours.value),
      timeZone: usageTimeZone(),
    });
    const loaded = await apiRequest<AiUsageReport>(`/api/v1/ai/usage?${query}`);
    if (requestId === usageRequestId) usage.value = loaded;
    return true;
  } catch (cause) {
    if (requestId === usageRequestId) usageError.value = errorMessage(cause);
    return false;
  } finally {
    if (requestId === usageRequestId) usageBusy.value = false;
  }
}
function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}
const providerHealthLabels: Record<string, string> = {
  healthy: "健康",
  degraded: "已降级",
  "half-open": "恢复探测",
};
const canOperate = computed(
  () =>
    detail.value !== null &&
    ["retrying", "failed", "dead-lettered"].includes(detail.value.status),
);
const retryBlocked = computed(() => {
  if (detail.value === null) return true;
  return detail.value.deliveries.some((delivery) =>
    ["sending", "unknown", "confirmed"].includes(delivery.status),
  );
});
const retryTitle = computed(() => {
  if (retryBlocked.value) return "发送结果未知或已确认，禁止盲目重发";
  if (detail.value?.status === "retrying") {
    return "计划重试仍可能运行；仅在服务端判定逾期后才能创建恢复执行";
  }
  return "创建关联原执行的新恢复执行";
});

function providerHealthLabel(state: string) {
  return providerHealthLabels[state] ?? state;
}

function percent(numerator: number | null, denominator: number | null) {
  if (numerator === null || denominator === null || denominator <= 0)
    return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

const cacheDivergenceReasonLabels: Readonly<Record<string, string>> = {
  "request-unchanged": "请求未变化",
  "append-only-growth": "历史仅追加",
  "request-configuration-changed": "请求配置变化",
  "cache-key-changed": "缓存键变化",
  "summary-changed": "历史摘要变化",
  "system-prompt-changed": "系统提示词变化",
  "history-window-shifted": "历史窗口移位",
  "history-message-changed": "历史消息内容变化",
  "participant-mapping-changed": "成员映射变化",
  "link-preview-changed": "链接预览变化",
  "history-image-selection-changed": "历史图片轮换",
  "history-image-content-changed": "历史图片内容变化",
  "current-image-selection-changed": "当前图片选择变化",
  "current-image-content-changed": "当前图片内容变化",
  "image-download-state-changed": "图片加载状态变化",
  "dynamic-input-changed": "本轮动态输入变化",
  unknown: "未知变化",
};

function cacheDivergenceReasonLabel(reason: string | null): string {
  if (reason === null) return "—";
  return cacheDivergenceReasonLabels[reason] ?? reason;
}

function providerAttemptPurpose(
  item: ExecutionDetail["aiProviderAttempts"][number],
) {
  if (item.purpose === "image-summary") return "图片摘要";
  const nodeType = detail.value?.nodes.find(
    (node) => node.nodeId === item.nodeId,
  )?.nodeType;
  switch (nodeType) {
    case "ai-chat":
      return "对话回复";
    default:
      return nodeType === undefined ? "AI 请求" : `AI 请求 · ${nodeType}`;
  }
}

function cacheStructureLabel(
  trace: NonNullable<
    NonNullable<
      ExecutionDetail["aiProviderAttempts"][number]["diagnostics"]
    >["requestTrace"]
  >,
) {
  if (trace.previousItemCount === null) return "等待下一请求建立对比";
  if (trace.cacheKeyMatchesPrevious === false) return "缓存键已变化";
  if (trace.configurationMatchesPrevious === false) return "请求配置已变化";
  if (trace.previousRequestIsExactPrefix === true) return "结构满足前缀缓存";
  return `前缀在第 ${(trace.divergenceIndex ?? 0) + 1} 项发生变化`;
}

async function load(reset = false): Promise<boolean> {
  if (!session.authenticated) {
    executionPager.clear();
    auditPager.clear();
    return false;
  }
  message.value = "";
  messageIsError.value = false;
  try {
    const requests = [
      reset ? executionPager.first() : executionPager.refresh(),
      loadUsage(),
    ];
    if (session.sensitiveActive) {
      requests.push(reset ? auditPager.first() : auditPager.refresh());
    } else {
      auditPager.clear();
    }
    await Promise.all(requests);
    return true;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
    return false;
  }
}

async function changePage(action: () => Promise<boolean>) {
  message.value = "";
  messageIsError.value = false;
  try {
    await action();
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  }
}

async function toggleRecoveryOnly() {
  recoveryOnly.value = !recoveryOnly.value;
  clearDetail();
  await changePage(executionPager.first);
}
async function inspect(id: string) {
  if (!session.authenticated) return;
  if (detail.value === null && document.activeElement instanceof HTMLElement) {
    detailReturnFocus = document.activeElement;
  }
  const requestId = ++inspectRequestId;
  detailLoadingId.value = id;
  message.value = "";
  messageIsError.value = false;
  try {
    const loaded = await apiRequest<ExecutionDetail>(
      `/api/v1/executions/${id}`,
    );
    if (requestId !== inspectRequestId) return;
    detail.value = loaded;
    rawRequests.value = {};
    rawResponses.value = {};
  } catch (cause) {
    if (requestId !== inspectRequestId) return;
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    if (requestId === inspectRequestId) detailLoadingId.value = null;
  }
}

let rawRequestEpoch = 0;
function clearDetail() {
  rawRequestEpoch += 1;
  inspectRequestId += 1;
  detailLoadingId.value = null;
  detail.value = null;
  rawRequests.value = {};
  rawResponses.value = {};
}

async function loadRawRequest(attemptId: string) {
  if (
    detail.value === null ||
    !session.sensitiveActive ||
    rawRequestLoadingId.value !== null
  )
    return;
  const epoch = rawRequestEpoch;
  const executionId = detail.value.id;
  rawRequestLoadingId.value = attemptId;
  message.value = "";
  messageIsError.value = false;
  try {
    const result = await apiRequest<{
      attemptId: string;
      requestHash: string | null;
      body: string;
    }>(
      `/api/v1/executions/${executionId}/ai-attempts/${attemptId}/raw-request`,
    );
    if (
      epoch !== rawRequestEpoch ||
      !session.sensitiveActive ||
      detail.value?.id !== executionId
    )
      return;
    rawRequests.value = {
      ...rawRequests.value,
      [attemptId]: JSON.stringify(JSON.parse(result.body), null, 2),
    };
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    rawRequestLoadingId.value = null;
  }
}

async function copyRawRequest(attemptId: string) {
  const body = rawRequests.value[attemptId];
  if (!session.sensitiveActive || body === undefined) return;
  try {
    await navigator.clipboard.writeText(body);
    message.value = "AI 请求原始报文已复制。";
    messageIsError.value = false;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  }
}
async function loadRawResponse(attemptId: string) {
  if (!detail.value || !session.sensitiveActive || responseLoadingId.value)
    return;
  const epoch = rawRequestEpoch;
  const executionId = detail.value.id;
  responseLoadingId.value = attemptId;
  try {
    const result = await apiRequest<RawResponse>(
      `/api/v1/executions/${executionId}/ai-attempts/${attemptId}/raw-response`,
    );
    if (
      epoch !== rawRequestEpoch ||
      !session.sensitiveActive ||
      detail.value?.id !== executionId
    )
      return;
    rawResponses.value = { ...rawResponses.value, [attemptId]: result };
  } catch (cause) {
    if (epoch === rawRequestEpoch && session.sensitiveActive) {
      message.value = errorMessage(cause);
      messageIsError.value = true;
    }
  } finally {
    responseLoadingId.value = null;
  }
}
async function copyRawResponse(attemptId: string) {
  const response = rawResponses.value[attemptId];
  if (!session.sensitiveActive || !response) return;
  try {
    await navigator.clipboard.writeText(response.body);
    message.value = response.truncated
      ? "已复制保留的响应片段（已截断）。"
      : "原始响应已复制。";
    messageIsError.value = false;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  }
}
async function loadSelected() {
  await load(true);
  const executionId = route.query.executionId;
  if (typeof executionId === "string") await inspect(executionId);
}
async function recover(action: "retry" | "close") {
  if (detail.value === null || !session.sensitiveActive || recoveryBusy.value)
    return;
  if (
    !window.confirm(
      action === "retry"
        ? "确认创建一条新的恢复执行？原执行历史会保留。"
        : "确认人工关闭这条失败执行？",
    )
  )
    return;
  recoveryBusy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    const result = await apiRequest<ExecutionDetail>(
      `/api/v1/executions/${detail.value.id}/${action}`,
      { method: "POST" },
    );
    detail.value = result;
    if (await executionPager.refresh()) {
      message.value =
        action === "retry" ? "已创建并执行恢复尝试。" : "执行已人工关闭。";
    }
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    recoveryBusy.value = false;
  }
}
watch(
  () => route.query.executionId,
  (executionId) => {
    if (typeof executionId === "string") void inspect(executionId);
  },
);
watch(
  () => detail.value !== null,
  async (open) => {
    if (open) {
      if (
        detailReturnFocus === null &&
        document.activeElement instanceof HTMLElement
      ) {
        detailReturnFocus = document.activeElement;
      }
      pageOverflowBeforeDetail = document.body.style.overflow;
      applicationRoot = document.getElementById("app");
      applicationRootWasInert = applicationRoot?.hasAttribute("inert") ?? false;
      applicationRoot?.setAttribute("inert", "");
      document.body.style.overflow = "hidden";
      await nextTick();
      detailDialog.value?.focus();
      return;
    }
    document.body.style.overflow = pageOverflowBeforeDetail;
    if (!applicationRootWasInert) applicationRoot?.removeAttribute("inert");
    applicationRoot = null;
    detailReturnFocus?.focus();
    detailReturnFocus = null;
  },
);
function onKeydown(event: KeyboardEvent) {
  if (document.querySelector("dialog[open]")) return;
  const dialog = detail.value === null ? null : detailDialog.value;
  if (dialog === null) return;
  if (event.key === "Escape") {
    if (detail.value !== null) clearDetail();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === dialog)
  ) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
window.addEventListener("keydown", onKeydown);
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  document.removeEventListener("visibilitychange", refreshUsageWhenVisible);
  if (usageRefreshTimer !== null) window.clearInterval(usageRefreshTimer);
  document.body.style.overflow = pageOverflowBeforeDetail;
  if (!applicationRootWasInert) applicationRoot?.removeAttribute("inert");
});
onMounted(() => {
  if (session.authenticated) void loadSelected();
  usageRefreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") void loadUsage();
  }, 60_000);
  document.addEventListener("visibilitychange", refreshUsageWhenVisible);
});
watch(
  () => session.authenticated,
  (active) => {
    if (active) void loadSelected();
    else {
      executionPager.clear();
      auditPager.clear();
      usage.value = null;
      clearDetail();
    }
  },
);
watch(
  () => session.sensitiveActive,
  (active) => {
    if (active) {
      void changePage(resetAuditPage);
    } else {
      auditPager.clear();
      rawRequestEpoch += 1;
      rawRequests.value = {};
      rawResponses.value = {};
    }
  },
);
watch(usageHours, () => {
  if (session.authenticated) void loadUsage();
});

function refreshUsageWhenVisible() {
  if (document.visibilityState === "visible" && session.authenticated) {
    void loadUsage();
  }
}

function resetAuditPage(): Promise<boolean> {
  return auditPager.first();
}

function routeTracePhaseLabel(phase: AiRouteTrace["phase"]): string {
  return (
    {
      standard: "标准调用",
      "image-original": "原生图片调用",
      "image-degraded": "降级为纯文本",
    }[phase] ?? phase
  );
}

function routeDecisionLabel(
  decision: AiRouteTrace["candidateDecisions"][number],
): string {
  const labels: Record<string, string> = {
    eligible: "符合调用条件",
    "provider-unavailable": "Provider 不可用",
    "provider-disabled": "Provider 已停用",
    "secret-missing": "缺少密钥",
    "image-capability-disabled": "未启用图片能力",
    "image-capability-unverified": "图片能力未验证",
    "web-search-unsupported": "不满足搜索/工具能力",
    "health-cooldown": "Provider 冷却中",
    "health-unavailable": "健康状态暂不可用",
    "retry-not-eligible": "不在本轮重试范围",
    "fallback-stopped": "Fallback 已停止",
    "probe-busy": "恢复探测已被占用",
    attempted: "已实际调用",
  };
  return labels[decision.reason] ?? decision.reason;
}

function routeDecisionStatusClass(
  decision: AiRouteTrace["candidateDecisions"][number],
): string {
  if (decision.decision === "attempted") return "published";
  if (decision.decision === "eligible") return "ready";
  return "warning";
}

function coverageRangeText(
  snapshot: Record<string, unknown>,
  key: "retained" | "omitted" | "windowEvicted",
): string {
  const coverage = snapshot.historyCoverage;
  if (!coverage || typeof coverage !== "object") return "未记录覆盖范围";
  if (!(key in coverage)) return "未记录覆盖范围";
  const range = (coverage as Record<string, unknown>)[key];
  if (!range || typeof range !== "object") return "无";
  const value = range as Record<string, unknown>;
  return `${contextSnapshotValue(value, "count")} 条 · M${contextSnapshotValue(value, "firstMessageIndex")}–M${contextSnapshotValue(value, "lastMessageIndex")} · ${contextSnapshotValue(value, "earliestSentAt")} 至 ${contextSnapshotValue(value, "latestSentAt")}`;
}

function contextSnapshotValue(
  snapshot: Record<string, unknown>,
  key: string,
): string {
  const value = snapshot[key];
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return "—";
}
</script>

<template>
  <main class="page-container split-admin-page reveal">
    <aside class="admin-sidebar">
      <div>
        <p class="eyebrow">TRACEABILITY</p>
        <h2>执行与审计</h2>
      </div>
      <nav>
        <button
          class="active"
          type="button"
          @click="scrollToSection('executions')"
        >
          <FileClock :size="18" />执行记录
        </button>

        <button type="button" @click="scrollToSection('audit')">
          <ShieldCheck :size="18" />审计事件
        </button>
        <button type="button" @click="scrollToSection('memory-jobs')">
          <FileClock :size="18" />历史索引
        </button>
      </nav>
      <div class="sidebar-note">
        普通轨迹只显示元数据、错误码和哈希；原始模型请求与响应需敏感授权后查看。
      </div>
    </aside>
    <div class="admin-workspace">
      <DismissibleMessage
        v-if="message"
        :error="messageIsError"
        @close="message = ''"
        >{{ message }}</DismissibleMessage
      >
      <SensitiveUnlock />
      <section class="admin-panel ai-usage-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">AI USAGE</p>
            <h1>AI 用量与缓存</h1>
            <p>长期查看 Provider 用量，短期观察请求和缓存命中变化。</p>
          </div>
          <span v-if="usage" class="state-badge">
            {{ usage.timeZone }} · {{ usage.bucketMinutes }} 分钟粒度
          </span>
        </div>

        <div v-if="usageError" class="inline-alert error">
          {{ usageError }}
        </div>

        <div class="usage-section-head">
          <div>
            <h2>长周期统计</h2>
            <p>自然日、ISO 周和自然月，按实际 Provider 请求汇总。</p>
          </div>
          <span v-if="usage" class="keyline">
            更新于 {{ new Date(usage.generatedAt).toLocaleString() }}
          </span>
        </div>
        <div v-if="usagePeriodRows.length" class="table-shell usage-table">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>今日</th>
                <th>本周</th>
                <th>本月</th>
                <th>本月缓存命中</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="item in usagePeriodRows"
                :key="item.providerId"
                :class="{ 'usage-total-row': item.providerId === 'all' }"
              >
                <td>
                  <strong>{{ item.providerName }}</strong>
                </td>
                <td>
                  <strong>{{
                    formatTokenCount(item.today.totalTokens)
                  }}</strong>
                  <span class="keyline"
                    >{{ item.today.requestCount }} 次请求</span
                  >
                </td>
                <td>
                  <strong>{{ formatTokenCount(item.week.totalTokens) }}</strong>
                  <span class="keyline"
                    >{{ item.week.requestCount }} 次请求</span
                  >
                </td>
                <td>
                  <strong>{{
                    formatTokenCount(item.month.totalTokens)
                  }}</strong>
                  <span class="keyline"
                    >{{ item.month.requestCount }} 次请求</span
                  >
                </td>
                <td>
                  <strong>{{
                    formatCacheRate(item.month.cacheHitRate)
                  }}</strong>
                  <span
                    v-if="item.month.cacheDataCoverage !== null"
                    class="keyline"
                    :title="`缓存统计覆盖 ${formatCacheRate(item.month.cacheDataCoverage)}`"
                  >
                    {{ formatTokenCount(item.month.cachedPromptTokens ?? 0) }} /
                    {{ formatTokenCount(item.month.cacheEligiblePromptTokens) }}
                    Token
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else-if="!usageBusy" class="empty-panel compact">
          暂无 AI Provider 用量数据。
        </div>

        <div class="usage-section-head realtime-head">
          <div>
            <h2>实时趋势</h2>
            <p>按 Provider 对比最近一段时间的 Token、请求和缓存命中。</p>
          </div>
          <div class="usage-realtime-actions">
            <label class="usage-hours-control">
              最近
              <select v-model.number="usageHours" :disabled="usageBusy">
                <option
                  v-for="hours in usageHourOptions"
                  :key="hours"
                  :value="hours"
                >
                  {{ hours }} 小时
                </option>
              </select>
            </label>
            <button
              type="button"
              class="button tiny secondary usage-refresh-button"
              :disabled="usageBusy"
              :aria-label="usageBusy ? '正在刷新实时趋势' : '刷新实时趋势'"
              :title="usageBusy ? '正在刷新' : '刷新实时趋势'"
              @click="loadUsage"
            >
              <RefreshCw
                :size="16"
                :class="{ 'button-spinner': usageBusy }"
                aria-hidden="true"
              />
              {{ usageBusy ? "刷新中" : "刷新" }}
            </button>
          </div>
        </div>
        <div v-if="hasRealtimeUsage && usage" class="usage-chart-grid">
          <article class="usage-chart-card">
            <h3>Token 使用量</h3>
            <p>各时间桶内 Provider 返回的总 Token。</p>
            <AiUsageChart
              metric="totalTokens"
              :providers="usageProviders"
              :points="usage.series"
            />
          </article>
          <article class="usage-chart-card">
            <h3>请求次数</h3>
            <p>实际发往 Provider 的请求，包括 Retry 和 Fallback。</p>
            <AiUsageChart
              metric="requestCount"
              :providers="usageProviders"
              :points="usage.series"
            />
          </article>
          <article class="usage-chart-card wide">
            <h3>缓存命中率</h3>
            <p>
              缓存命中输入 Token ÷ 可统计的输入
              Token；圆点表示有缓存统计的时间桶，空档表示无请求或 Provider
              未返回缓存数据。
            </p>
            <AiUsageChart
              metric="cacheHitRate"
              :providers="usageProviders"
              :points="usage.series"
            />
          </article>
        </div>
        <div v-else-if="!usageBusy" class="empty-panel compact">
          最近 {{ usageHours }} 小时暂无实时 AI 请求。
        </div>
        <div v-if="usageBusy && usage === null" class="empty-panel compact">
          正在加载 AI 用量统计…
        </div>
      </section>
      <section id="executions" class="admin-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">EXECUTION TRACE</p>
            <h1>工作流执行</h1>
            <p class="keyline">
              回复缓存命中仅统计 ai-chat 对话请求；图片摘要等辅助请求不计入。
            </p>
          </div>
          <div class="row-actions">
            <button
              class="button tiny"
              :class="recoveryOnly ? 'primary' : 'secondary'"
              @click="toggleRecoveryOnly"
            >
              恢复队列</button
            ><button
              class="button secondary"
              :disabled="busy"
              @click="load(false)"
            >
              <RefreshCw :size="16" />刷新
            </button>
          </div>
        </div>
        <div class="table-shell">
          <table>
            <thead>
              <tr>
                <th>工作流</th>
                <th>聊天</th>
                <th>状态</th>
                <th>回复缓存命中</th>
                <th>时间</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!executions.length">
                <td colspan="6" class="empty-cell">暂无执行</td>
              </tr>
              <tr v-for="item in executions" :key="item.id">
                <td>
                  <strong>{{ item.workflowName }}</strong
                  ><span class="keyline"
                    >v{{ item.workflowVersion }} · {{ item.id }}</span
                  ><span v-if="item.recoveryAttempt" class="keyline"
                    >恢复 #{{ item.recoveryAttempt }}</span
                  >
                </td>
                <td>
                  <strong>{{
                    item.chatDisplayName || item.providerChatId || "—"
                  }}</strong>
                  <span
                    v-if="item.chatDisplayName && item.providerChatId"
                    class="keyline"
                    >{{ item.providerChatId }}</span
                  >
                </td>
                <td>
                  <span class="table-status" :class="item.status">{{
                    item.status
                  }}</span>
                </td>
                <td>
                  <span class="cache-rate-line">
                    <strong>{{ formatCacheRate(item.cacheHitRate) }}</strong>
                  </span>
                  <span v-if="item.cachedPromptTokens !== null" class="keyline"
                    >{{ formatTokenCount(item.cachedPromptTokens) }} /
                    {{ formatTokenCount(item.cacheEligiblePromptTokens) }}</span
                  >
                </td>
                <td>{{ new Date(item.createdAt).toLocaleString() }}</td>
                <td>
                  <button
                    class="button tiny secondary"
                    :disabled="detailLoadingId === item.id"
                    :aria-busy="detailLoadingId === item.id"
                    @click="inspect(item.id)"
                  >
                    <Search :size="14" />{{
                      detailLoadingId === item.id ? "加载中…" : "详情"
                    }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <CursorPagination
          :page="executionPager.pageNumber.value"
          :item-count="executions.length"
          :busy="executionPager.busy.value"
          :has-previous="executionPager.hasPrevious.value"
          :has-next="executionPager.hasNext.value"
          @previous="changePage(executionPager.previous)"
          @next="changePage(executionPager.next)"
        />
      </section>
      <MemoryPanel id="memory-jobs" mode="jobs" embedded />
      <section id="audit" class="admin-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">AUDIT & SEARCH</p>
            <h2>审计事件</h2>
          </div>
          <span class="state-badge">不含正文与 Secret</span>
        </div>
        <div v-if="!session.sensitiveActive" class="empty-panel sensitive-mask">
          <ShieldCheck :size="24" />
          <strong>审计事件已遮蔽</strong>
          <span>完成二次验证后才能查看审计事件。</span>
        </div>
        <div v-else class="table-shell">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>主体</th>
                <th>动作</th>
                <th>目标</th>
                <th>结果</th>
                <th>关联 ID</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!audits.length">
                <td colspan="6" class="empty-cell">暂无审计事件</td>
              </tr>
              <tr v-for="item in audits" :key="item.id">
                <td>{{ new Date(item.occurredAt).toLocaleString() }}</td>
                <td>{{ item.actorType }}</td>
                <td>{{ item.action }}</td>
                <td>
                  {{ item.targetType
                  }}<span class="keyline">{{ item.targetId || "—" }}</span>
                </td>
                <td>
                  <span class="table-status" :class="item.outcome">{{
                    item.outcome
                  }}</span>
                </td>
                <td class="mono">{{ item.correlationId.slice(0, 8) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <CursorPagination
          v-if="session.sensitiveActive"
          :page="auditPager.pageNumber.value"
          :item-count="audits.length"
          :busy="auditPager.busy.value"
          :has-previous="auditPager.hasPrevious.value"
          :has-next="auditPager.hasNext.value"
          @previous="changePage(auditPager.previous)"
          @next="changePage(auditPager.next)"
        />
      </section>
    </div>
  </main>
  <Teleport to="body">
    <div
      v-if="detail"
      class="execution-detail-backdrop"
      @click.self="clearDetail"
    >
      <section
        ref="detailDialog"
        class="execution-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="execution-detail-title"
        tabindex="-1"
      >
        <header class="execution-detail-header">
          <div class="execution-detail-heading">
            <p class="card-kicker">{{ detail.correlationId }}</p>
            <h2 id="execution-detail-title">
              {{ detail.workflowName }} · v{{ detail.workflowVersion }}
            </h2>
            <p v-if="detail.retryOfExecutionId" class="keyline">
              恢复自 {{ detail.retryOfExecutionId }} · 第
              {{ detail.recoveryAttempt }} 次
            </p>
          </div>
          <div class="row-actions execution-detail-actions">
            <button
              v-if="canOperate"
              class="button secondary"
              :disabled="
                !session.sensitiveActive || retryBlocked || recoveryBusy
              "
              :title="recoveryBusy ? '恢复请求处理中' : retryTitle"
              @click="recover('retry')"
            >
              <RotateCcw :size="15" />{{
                recoveryBusy ? "处理中…" : "人工重试"
              }}</button
            ><button
              v-if="canOperate"
              class="button danger-ghost"
              :disabled="!session.sensitiveActive || recoveryBusy"
              @click="recover('close')"
            >
              <XCircle :size="15" />{{
                recoveryBusy ? "处理中…" : "人工关闭"
              }}</button
            ><button
              class="icon-button execution-detail-close"
              type="button"
              title="关闭执行详情"
              aria-label="关闭执行详情"
              @click="clearDetail"
            >
              <X :size="19" />
            </button>
          </div>
        </header>
        <div class="execution-detail-body">
          <section class="context-snapshot-card">
            <h3>本次 Bot 角色</h3>
            <p v-if="detail.botIdentity">
              {{ detail.botIdentity.nickname ?? "未命名 Bot" }} · 工作流
              {{ detail.botIdentity.workflowId }} · 配置版本
              {{ detail.botIdentity.version }}
            </p>
            <p v-else>未记录角色身份</p>
          </section>
          <section v-if="detail.contextSnapshot" class="context-snapshot-card">
            <div class="context-snapshot-heading">
              <div>
                <h3>上下文读取</h3>
                <p class="keyline">
                  本次执行固定使用的历史窗口与触发消息边界。
                </p>
              </div>
            </div>
            <dl class="context-snapshot-grid">
              <div>
                <dt>聊天</dt>
                <dd>
                  {{ contextSnapshotValue(detail.contextSnapshot, "chatId") }}
                </dd>
              </div>
              <div>
                <dt>触发消息</dt>
                <dd>
                  M{{
                    contextSnapshotValue(
                      detail.contextSnapshot,
                      "triggerMessageIndex",
                    )
                  }}
                </dd>
              </div>

              <div>
                <dt>实际上下文</dt>
                <dd>
                  {{
                    contextSnapshotValue(
                      detail.contextSnapshot,
                      "contextCharacters",
                    )
                  }}
                  字符
                </dd>
              </div>
              <div>
                <dt>历史裁剪</dt>
                <dd>
                  {{
                    contextSnapshotValue(
                      detail.contextSnapshot,
                      "truncatedMessageCount",
                    )
                  }}
                  条
                </dd>
              </div>
            </dl>
            <details v-if="detail.contextSnapshot.authorAttributions">
              <summary>
                消息作者归属（未知
                {{ detail.contextSnapshot.unknownSelfCount ?? 0 }} 条，归属冲突
                {{ detail.contextSnapshot.attributionConflictCount ?? 0 }} 条）
              </summary>
              <pre>{{
                JSON.stringify(
                  detail.contextSnapshot.authorAttributions,
                  null,
                  2,
                )
              }}</pre>
            </details>
            <p v-if="detail.contextSnapshot.chatSummaryRetired">
              聊天摘要内容已随功能移除。
            </p>
            <p>
              窗口移出：{{
                coverageRangeText(detail.contextSnapshot, "windowEvicted")
              }}
            </p>
            <p>
              配置版本：{{
                contextSnapshotValue(detail.contextSnapshot, "settingsVersion")
              }}
            </p>
            <p>
              保留原文：{{
                coverageRangeText(detail.contextSnapshot, "retained")
              }}
            </p>
            <p>
              字符裁剪范围：{{
                coverageRangeText(detail.contextSnapshot, "omitted")
              }}
            </p>
            <p
              v-if="detail.contextSnapshot.contextIncomplete === true"
              class="context-snapshot-note"
            >
              本次上下文不完整。
              <span
                v-if="
                  Array.isArray(detail.contextSnapshot.contextIncompleteReasons)
                "
              >
                {{
                  detail.contextSnapshot.contextIncompleteReasons
                    .map((reason: string) =>
                      reason === "window-evicted"
                        ? "较早原文已移出上下文窗口"
                        : reason === "history-trimmed"
                          ? "历史原文因字符预算被裁剪"
                          : reason === "character-overflow"
                            ? "内容超过字符保护边界"
                            : reason,
                    )
                    .join("；")
                }}
              </span>
            </p>
          </section>
          <div class="trace-columns">
            <section>
              <h3>节点轨迹</h3>
              <article
                v-for="node in detail.nodes"
                :key="node.id"
                class="trace-item"
              >
                <span class="trace-dot" :class="node.status"></span>
                <div>
                  <strong>{{ node.nodeId }} · {{ node.nodeType }}</strong>
                  <p>
                    attempt {{ node.attempt }} · {{ node.durationMs ?? "—" }} ms
                    ·
                    {{ node.errorCode || node.status }}
                  </p>
                  <AgentBudgetDetails
                    v-if="node.nodeType === 'ai-chat'"
                    :summary="node.outputSummary"
                  />
                  <details>
                    <summary>脱敏摘要</summary>
                    <pre>{{
                      JSON.stringify(
                        {
                          input: node.inputSummary,
                          output: node.outputSummary,
                        },
                        null,
                        2,
                      )
                    }}</pre>
                  </details>
                </div>
              </article>
            </section>
            <section>
              <h3>AI 路由决策</h3>
              <article
                v-for="trace in detail.aiRouteTraces"
                :key="trace.id"
                class="trace-item"
              >
                <Route :size="17" />
                <div>
                  <div class="provider-attempt-heading">
                    <strong>
                      {{ trace.routeName || "路由不可用" }} · v{{
                        trace.routeVersion ?? "—"
                      }}
                    </strong>
                    <span class="table-status" :class="trace.terminalStatus">
                      {{ routeTracePhaseLabel(trace.phase) }}
                    </span>
                  </div>
                  <p>
                    {{
                      trace.requestRequirements.hasImages
                        ? "携带图片"
                        : "纯文本"
                    }}
                    ·
                    {{
                      trace.requestRequirements.requiresTools
                        ? "需要工具"
                        : "无需工具"
                    }}
                    · 搜索
                    {{ trace.requestRequirements.webSearch || "未请求" }} ·
                    {{ trace.candidateDecisions.length }} 条候选决策 ·
                    {{ trace.durationMs }} ms
                  </p>
                  <details>
                    <summary>候选选择与跳过原因</summary>
                    <div class="route-candidate-grid">
                      <div
                        v-for="(candidate, index) in trace.candidateDecisions"
                        :key="candidate.providerId + ':' + index"
                        class="route-candidate-item"
                      >
                        <span>
                          #{{ candidate.configuredPosition }}
                          {{ candidate.providerName || candidate.providerId }}
                          <template v-if="candidate.model">
                            · {{ candidate.model }}
                          </template>
                          ·
                          {{
                            candidate.round === null
                              ? "预检"
                              : `第 ${candidate.round} 轮`
                          }}
                          <template
                            v-if="candidate.imageInputConfigured !== null"
                          >
                            · 图片
                            {{
                              candidate.imageInputConfigured ? "开启" : "关闭"
                            }}
                            / {{ candidate.imageInputProbe || "unknown" }}
                          </template>
                        </span>
                        <span
                          class="table-status"
                          :class="routeDecisionStatusClass(candidate)"
                        >
                          {{ routeDecisionLabel(candidate) }}
                        </span>
                      </div>
                    </div>
                  </details>
                </div>
              </article>
              <p v-if="!detail.aiRouteTraces.length" class="keyline">
                历史执行未记录路由决策，不使用当前配置反推。
              </p>
            </section>
            <section class="provider-attempt-section">
              <h3>AI 请求详情</h3>
              <article
                v-for="item in detail.aiProviderAttempts"
                :key="item.id"
                class="trace-item"
              >
                <Route :size="17" />
                <div>
                  <div class="provider-attempt-heading">
                    <strong>{{ item.providerName }} · {{ item.model }}</strong>
                    <span class="provider-attempt-purpose">{{
                      providerAttemptPurpose(item)
                    }}</span>
                  </div>
                  <span class="keyline"
                    >路由 v{{ item.routeVersion }} · Provider v{{
                      item.providerVersion
                    }}</span
                  >
                  <p>
                    Agent 第 {{ item.agentTurn }} 轮 · 路由第
                    {{ item.round }} 轮 / 顺序 {{ item.sequence }} ·
                    {{ routeTracePhaseLabel(item.routePhase) }} ·
                    {{ item.durationMs }} ms · 选择时
                    {{ providerHealthLabel(item.selectionHealthState) }} → 结果
                    {{ providerHealthLabel(item.healthState) }}
                  </p>
                  <span v-if="item.errorCode" class="table-status danger">{{
                    [item.errorCategory, item.errorCode]
                      .filter(Boolean)
                      .join(" · ")
                  }}</span>
                  <span v-if="item.status === 'failed'" class="keyline"
                    >{{ item.retryable ? "可重试" : "不可重试" }} ·
                    {{
                      item.fallbackAllowed ? "允许 Fallback" : "停止 Fallback"
                    }}</span
                  >
                  <p v-if="item.diagnostics" class="keyline">
                    HTTP {{ item.diagnostics.httpStatus ?? "—" }} · 请求
                    {{ item.diagnostics.requestMessageCount }} 条消息 /
                    {{ item.diagnostics.requestCharacters }} 字符 · 响应
                    {{ item.diagnostics.responseBytes ?? "—" }} B · 可见输出
                    {{ item.diagnostics.responseContentCharacters ?? "—" }}
                    字符
                  </p>
                  <p v-if="item.diagnostics" class="keyline">
                    Token：输入 {{ item.diagnostics.promptTokens ?? "—" }} ·
                    输出 {{ item.diagnostics.completionTokens ?? "—" }} · 推理
                    {{ item.diagnostics.reasoningTokens ?? "—" }} · 缓存命中
                    {{ item.diagnostics.cachedPromptTokens ?? "—" }} · 缓存写入
                    {{ item.diagnostics.cacheWritePromptTokens ?? "—" }} ·
                    未命中
                    {{ item.diagnostics.cacheMissPromptTokens ?? "—" }}
                  </p>
                  <span
                    v-if="item.diagnostics?.providerRequestId"
                    class="keyline"
                    >Provider Request ID：{{
                      item.diagnostics.providerRequestId
                    }}</span
                  >
                  <span
                    v-if="item.diagnostics?.responseFinishReason"
                    class="keyline"
                  >
                    {{
                      item.diagnostics.responseFinishReason === "length" ||
                      item.diagnostics.responseFinishReason.startsWith(
                        "incomplete",
                      )
                        ? "模型输出未完成 · "
                        : ""
                    }}Finish Reason：{{ item.diagnostics.responseFinishReason }}
                    · 推理字段
                    {{ item.diagnostics.responseReasoningCharacters ?? 0 }}
                    字符</span
                  >
                  <details v-if="item.diagnostics" class="keyline">
                    <summary>诊断标识</summary>
                    <code
                      >client={{
                        item.diagnostics.clientRequestId || "—"
                      }}</code
                    >
                    <code>request={{ item.diagnostics.requestHash }}</code>
                    <code v-if="item.diagnostics.responseBodyHash"
                      >response={{ item.diagnostics.responseBodyHash }}</code
                    >
                  </details>
                  <div class="attempt-payloads">
                    <details
                      v-if="item.rawResponse?.status === 'available'"
                      class="raw-request-diagnostic response-diagnostic"
                      @toggle="
                        ($event.currentTarget as HTMLDetailsElement).open &&
                        !rawResponses[item.id] &&
                        loadRawResponse(item.id)
                      "
                    >
                      <summary>
                        <span><FileJson :size="14" /> 响应与错误详情</span>
                      </summary>
                      <p
                        v-if="responseLoadingId === item.id"
                        class="raw-request-loading"
                      >
                        正在读取…
                      </p>
                      <template v-if="rawResponses[item.id]">
                        <dl class="response-error-fields">
                          <div>
                            <dt>HTTP 状态</dt>
                            <dd>{{ rawResponses[item.id]!.httpStatus }}</dd>
                          </div>
                          <div
                            v-for="(value, key) in rawResponses[item.id]!.error"
                            :key="key"
                          >
                            <dt>{{ key }}</dt>
                            <dd>{{ value }}</dd>
                          </div>
                          <div
                            v-for="(value, key) in rawResponses[item.id]!
                              .requestIds"
                            :key="key"
                          >
                            <dt>{{ key }}</dt>
                            <dd>{{ value }}</dd>
                          </div>
                        </dl>
                        <div class="response-body-heading">
                          <strong>原始响应正文</strong
                          ><button
                            class="button tiny secondary"
                            @click="copyRawResponse(item.id)"
                          >
                            <ClipboardCopy :size="14" />复制{{
                              rawResponses[item.id]!.truncated ? "片段" : "正文"
                            }}
                          </button>
                        </div>
                        <p
                          v-if="rawResponses[item.id]!.truncated"
                          class="keyline"
                        >
                          响应共
                          {{ rawResponses[item.id]!.bytes }} 字节，仅保留前 64
                          KiB 以内内容，复制结果也已截断。
                        </p>
                        <pre>{{
                          rawResponses[item.id]!.body || "（空响应正文）"
                        }}</pre>
                      </template>
                    </details>
                    <p v-else class="keyline raw-request-unavailable">
                      当前实例无可用原始响应：可能尚未收到完整响应、未曾保存或缓存已过期。
                    </p>
                    <details
                      v-if="item.rawRequest.status === 'available'"
                      class="raw-request-diagnostic"
                      @toggle="
                        ($event.currentTarget as HTMLDetailsElement).open &&
                        rawRequests[item.id] === undefined &&
                        loadRawRequest(item.id)
                      "
                    >
                      <summary>
                        <span><FileJson :size="14" /> 原始请求报文</span>
                        <button
                          v-if="rawRequests[item.id] !== undefined"
                          class="icon-button raw-request-copy"
                          type="button"
                          title="复制原始请求报文"
                          aria-label="复制原始请求报文"
                          @click.prevent.stop="copyRawRequest(item.id)"
                        >
                          <ClipboardCopy :size="14" />
                        </button>
                      </summary>
                      <div
                        v-if="rawRequestLoadingId === item.id"
                        class="raw-request-loading"
                      >
                        <LoaderCircle :size="14" class="spin" /> 正在读取…
                      </div>
                      <pre v-else-if="rawRequests[item.id] !== undefined">{{
                        rawRequests[item.id]
                      }}</pre>
                    </details>
                    <p v-else class="keyline raw-request-unavailable">
                      当前实例未保留此原始请求报文。可能未曾保存、应用已重启、超出最近
                      20 个执行，或由其他实例处理。
                    </p>
                  </div>
                  <details
                    v-if="item.diagnostics?.requestTrace"
                    class="cache-diagnostic"
                  >
                    <summary>
                      <span>缓存诊断</span>
                      <span class="cache-diagnostic-verdict">{{
                        cacheStructureLabel(item.diagnostics.requestTrace)
                      }}</span>
                    </summary>
                    <div class="cache-diagnostic-grid">
                      <div>
                        <span>请求结构</span>
                        <strong
                          >{{
                            item.diagnostics.requestTrace.previousItemCount ??
                            "—"
                          }}
                          →
                          {{ item.diagnostics.requestTrace.items.length }}
                          项</strong
                        >
                      </div>
                      <div>
                        <span>共同前缀</span>
                        <strong
                          >{{
                            item.diagnostics.requestTrace
                              .sharedPrefixItemCount ?? "—"
                          }}
                          项 ·
                          {{
                            percent(
                              item.diagnostics.requestTrace
                                .sharedPrefixItemCount,
                              item.diagnostics.requestTrace.previousItemCount,
                            )
                          }}</strong
                        >
                      </div>
                      <div>
                        <span>固定缓存键</span>
                        <strong>{{
                          item.diagnostics.requestTrace.cacheKeyHash === null
                            ? "未启用"
                            : item.diagnostics.requestTrace
                                  .cacheKeyMatchesPrevious === null
                              ? "已启用 · 待对比"
                              : item.diagnostics.requestTrace
                                    .cacheKeyMatchesPrevious
                                ? "稳定"
                                : "已变化"
                        }}</strong>
                      </div>
                      <div>
                        <span>Provider 实际命中</span>
                        <strong
                          >{{ item.diagnostics.cachedPromptTokens ?? "—" }} /
                          {{ item.diagnostics.promptTokens ?? "—" }} Token ·
                          {{
                            percent(
                              item.diagnostics.cachedPromptTokens,
                              item.diagnostics.promptTokens,
                            )
                          }}</strong
                        >
                      </div>
                    </div>
                    <p class="cache-diagnostic-meta">
                      接口 {{ item.diagnostics.requestTrace.apiKind }} · 配置{{
                        item.diagnostics.requestTrace
                          .configurationMatchesPrevious === null
                          ? "待对比"
                          : item.diagnostics.requestTrace
                                .configurationMatchesPrevious
                            ? "一致"
                            : "变化"
                      }}
                      · 首个差异项：{{
                        item.diagnostics.requestTrace.divergenceIndex === null
                          ? "—"
                          : item.diagnostics.requestTrace.divergenceIndex + 1
                      }}
                      · 区域：{{
                        item.diagnostics.requestTrace.divergenceRegion ?? "—"
                      }}
                      · 原因：{{
                        cacheDivergenceReasonLabel(
                          item.diagnostics.requestTrace.divergenceReason,
                        )
                      }}
                    </p>
                    <details class="cache-diagnostic-details">
                      <summary>逐项哈希与高级诊断</summary>
                      <code
                        >trace={{
                          item.diagnostics.requestTrace.traceKeyHash
                        }}</code
                      >
                      <code
                        >config={{
                          item.diagnostics.requestTrace.configurationHash
                        }}</code
                      >
                      <code v-if="item.diagnostics.requestTrace.cacheKeyHash"
                        >cache={{
                          item.diagnostics.requestTrace.cacheKeyHash
                        }}</code
                      >
                      <div class="request-trace-items">
                        <div
                          v-for="traceItem in item.diagnostics.requestTrace
                            .items"
                          :key="item.id + '-trace-' + traceItem.index"
                          class="request-trace-item"
                        >
                          <strong
                            >#{{ traceItem.index + 1 }} ·
                            {{ traceItem.role }}</strong
                          >
                          <span
                            >{{ traceItem.contentKinds.join(", ") || "text" }} ·
                            文本 {{ traceItem.textCharacters }} 字符 · 图片
                            {{ traceItem.imageCount }} 张 /
                            {{ traceItem.imageBytes }} B</span
                          >
                          <code>item={{ traceItem.itemHash }}</code>
                          <code>prefix={{ traceItem.prefixHash }}</code>
                        </div>
                      </div>
                    </details>
                  </details>
                </div>
              </article>
              <div
                v-if="!detail.aiProviderAttempts.length"
                class="empty-panel compact"
              >
                本次执行没有 AI 调用。
              </div>
            </section>
            <section>
              <h3>AI 图片输入</h3>
              <article
                v-for="item in detail.aiImageInputs"
                :key="item.id"
                class="trace-item"
              >
                <Image :size="17" />
                <div>
                  <strong>{{ item.source }} · {{ item.status }}</strong>
                  <p>
                    {{ item.durationMs }} ms · {{ item.bytes ?? "—" }} B ·
                    {{
                      item.actualMimeType ||
                      item.declaredMimeType ||
                      "未知 MIME"
                    }}
                    · detail={{ item.detail }}
                  </p>
                  <span v-if="item.hostName" class="keyline"
                    >主机：{{ item.hostName }}</span
                  >
                  <span v-if="item.errorCode" class="table-status danger">{{
                    item.errorCode
                  }}</span>
                  <details class="keyline">
                    <summary>诊断标识</summary>
                    <code>source={{ item.sourceHash }}</code>
                    <code>node={{ item.nodeId }}</code>
                  </details>
                </div>
              </article>
              <div
                v-if="!detail.aiImageInputs.length"
                class="empty-panel compact"
              >
                本次执行没有图片输入。
              </div>
            </section>
            <section>
              <h3>AI 工具调用</h3>
              <article
                v-for="item in detail.aiToolExecutions"
                :key="item.id"
                class="trace-item"
              >
                <Search :size="17" />
                <div>
                  <strong>{{ item.toolName }} · {{ item.status }}</strong>
                  <p>
                    {{ item.durationMs }} ms · 结果
                    {{ item.resultCount ?? "—" }} 条
                  </p>
                  <span v-if="item.errorCode" class="table-status danger">{{
                    item.errorCode
                  }}</span>
                  <span
                    v-else-if="item.responseDetails?.outcome === 'no_results'"
                    class="table-status warning"
                    >AI_WEB_SEARCH_NO_RESULTS</span
                  >
                  <MemorySources
                    v-if="
                      typeof item.requestDetails?.retrievalId === 'string' &&
                      Array.isArray(item.responseDetails?.sourceRefs)
                    "
                    :retrieval-id="item.requestDetails.retrievalId"
                    :refs="
                      item.responseDetails.sourceRefs.filter(
                        (value): value is string => typeof value === 'string',
                      )
                    "
                  />
                  <details class="keyline">
                    <summary>诊断标识</summary>
                    <code>query={{ item.queryHash }}</code>
                    <code>call={{ item.toolCallId }}</code>
                  </details>
                  <details
                    v-if="item.requestDetails || item.responseDetails"
                    class="keyline"
                  >
                    <summary>搜索请求与返回</summary>
                    <pre>{{
                      JSON.stringify(
                        {
                          request: item.requestDetails,
                          response: item.responseDetails,
                        },
                        null,
                        2,
                      )
                    }}</pre>
                  </details>
                </div>
              </article>
              <div
                v-if="!detail.aiToolExecutions.length"
                class="empty-panel compact"
              >
                本次执行没有工具调用。
              </div>
            </section>
            <section>
              <h3>出站发送</h3>
              <article
                v-for="item in detail.deliveries"
                :key="item.id"
                class="trace-item"
              >
                <span class="trace-dot" :class="item.status"></span>
                <div>
                  <strong>{{ item.nodeId }} · {{ item.status }}</strong>
                  <p>
                    {{ item.attemptCount }} 次尝试 ·
                    {{ item.errorCode || "无错误" }}
                  </p>
                </div>
              </article>
            </section>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>
