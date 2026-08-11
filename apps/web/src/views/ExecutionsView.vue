<script setup lang="ts">
import {
  FileClock,
  Image,
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
        divergenceIndex: number | null;
        items: Array<{
          index: number;
          role: string;
          contentKinds: string[];
          textCharacters: number;
          imageCount: number;
          imageBytes: number;
          itemHash: string;
          prefixHash: string;
        }>;
      } | null;
    } | null;
  }>;
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
  const query = new URLSearchParams({ limit: "50" });
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
  } catch (cause) {
    if (requestId !== inspectRequestId) return;
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    if (requestId === inspectRequestId) detailLoadingId.value = null;
  }
}
function clearDetail() {
  inspectRequestId += 1;
  detailLoadingId.value = null;
  detail.value = null;
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
  if (detail.value === null) return;
  if (event.key === "Escape") {
    clearDetail();
    return;
  }
  if (event.key !== "Tab" || detailDialog.value === null) return;
  const focusable = Array.from(
    detailDialog.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
  if (focusable.length === 0) {
    event.preventDefault();
    detailDialog.value.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (
    event.shiftKey &&
    (document.activeElement === first ||
      document.activeElement === detailDialog.value)
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
    if (active) void changePage(resetAuditPage);
    else auditPager.clear();
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
      </nav>
      <div class="sidebar-note">
        轨迹只保存输入输出摘要、错误码和哈希，不保存完整 Prompt、AI 输出或
        Secret。
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
                <th>触发器</th>
                <th>状态</th>
                <th>当前节点</th>
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
                <td>{{ item.triggerName }}</td>
                <td>
                  <span class="table-status" :class="item.status">{{
                    item.status
                  }}</span>
                </td>
                <td>{{ item.currentNodeId || "—" }}</td>
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
              <h3>AI Provider Attempt</h3>
              <article
                v-for="item in detail.aiProviderAttempts"
                :key="item.id"
                class="trace-item"
              >
                <Route :size="17" />
                <div>
                  <strong>{{ item.providerName }} · {{ item.model }}</strong>
                  <span class="keyline"
                    >路由 v{{ item.routeVersion }} · Provider v{{
                      item.providerVersion
                    }}</span
                  >
                  <p>
                    Agent 第 {{ item.agentTurn }} 轮 · 路由第
                    {{ item.round }} 轮 / 顺序 {{ item.sequence }} ·
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
                    >Finish Reason：{{ item.diagnostics.responseFinishReason }}
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
                  <details
                    v-if="item.diagnostics?.requestTrace"
                    class="keyline"
                  >
                    <summary>AI 请求结构追踪</summary>
                    <p>
                      接口 {{ item.diagnostics.requestTrace.apiKind }} · 当前
                      {{ item.diagnostics.requestTrace.items.length }} 项 ·
                      上一请求
                      {{
                        item.diagnostics.requestTrace.previousItemCount ?? "—"
                      }}
                      项 · 共同前缀
                      {{
                        item.diagnostics.requestTrace.sharedPrefixItemCount ??
                        "—"
                      }}
                      项
                    </p>
                    <p>
                      上一请求是完整前缀：{{
                        item.diagnostics.requestTrace
                          .previousRequestIsExactPrefix === null
                          ? "无基线"
                          : item.diagnostics.requestTrace
                                .previousRequestIsExactPrefix
                            ? "是"
                            : "否"
                      }}
                      · 配置一致：{{
                        item.diagnostics.requestTrace
                          .configurationMatchesPrevious === null
                          ? "无基线"
                          : item.diagnostics.requestTrace
                                .configurationMatchesPrevious
                            ? "是"
                            : "否"
                      }}
                      · 首个差异项：{{
                        item.diagnostics.requestTrace.divergenceIndex ?? "—"
                      }}
                    </p>
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
                    <div
                      v-for="traceItem in item.diagnostics.requestTrace.items"
                      :key="item.id + '-trace-' + traceItem.index"
                      class="trace-item"
                    >
                      <strong
                        >#{{ traceItem.index }} · {{ traceItem.role }}</strong
                      >
                      <span>
                        {{ traceItem.contentKinds.join(", ") || "text" }} · 文本
                        {{ traceItem.textCharacters }} 字符 · 图片
                        {{ traceItem.imageCount }} 张 /
                        {{ traceItem.imageBytes }} B
                      </span>
                      <code>item={{ traceItem.itemHash }}</code>
                      <code>prefix={{ traceItem.prefixHash }}</code>
                    </div>
                  </details>
                </div>
              </article>
              <div
                v-if="!detail.aiProviderAttempts.length"
                class="empty-panel compact"
              >
                本次执行没有 AI 调用。
              </div>
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
