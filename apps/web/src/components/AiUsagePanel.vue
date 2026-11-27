<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RefreshCw } from "@lucide/vue";
import AiUsageChart from "./AiUsageChart.vue";
import { apiRequest, errorMessage } from "../services/api";
import { useSessionStore } from "../stores/session";
import { formatDateTime } from "../utils/format";

/** AI usage and cache statistics (moved here from the executions page). */
const session = useSessionStore();
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

const usage = ref<AiUsageReport | null>(null);
const usageHours = ref<AiUsageReport["hours"]>(24);
const usageBusy = ref(false);
const usageError = ref("");
let usageRequestId = 0;
let usageRefreshTimer: number | null = null;

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

function refreshUsageWhenVisible() {
  if (document.visibilityState === "visible" && session.authenticated) {
    void loadUsage();
  }
}
onMounted(() => {
  void loadUsage();
  usageRefreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") void loadUsage();
  }, 60_000);
  document.addEventListener("visibilitychange", refreshUsageWhenVisible);
});
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", refreshUsageWhenVisible);
  if (usageRefreshTimer !== null) window.clearInterval(usageRefreshTimer);
});
watch(usageHours, () => {
  if (session.authenticated) void loadUsage();
});
watch(
  () => session.authenticated,
  (active) => {
    if (active) void loadUsage();
    else usage.value = null;
  },
);
</script>

<template>
  <section class="admin-panel ai-usage-panel">
    <div class="panel-head">
      <div>
        <p class="card-kicker">用量</p>
        <h2>AI 用量与缓存</h2>
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
        <h3>长周期统计</h3>
        <p>自然日、ISO 周和自然月，按实际 Provider 请求汇总。</p>
      </div>
      <span v-if="usage" class="keyline">
        更新于 {{ formatDateTime(usage.generatedAt) }}
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
              <strong>{{ formatTokenCount(item.today.totalTokens) }}</strong>
              <span class="keyline">{{ item.today.requestCount }} 次请求</span>
            </td>
            <td>
              <strong>{{ formatTokenCount(item.week.totalTokens) }}</strong>
              <span class="keyline">{{ item.week.requestCount }} 次请求</span>
            </td>
            <td>
              <strong>{{ formatTokenCount(item.month.totalTokens) }}</strong>
              <span class="keyline">{{ item.month.requestCount }} 次请求</span>
            </td>
            <td>
              <strong>{{ formatCacheRate(item.month.cacheHitRate) }}</strong>
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
        <h3>实时趋势</h3>
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
</template>
