<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import uPlot, { type AlignedData } from "uplot";
import "uplot/dist/uPlot.min.css";

interface UsageMetrics {
  requestCount: number;
  succeededRequestCount: number;
  failedRequestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number | null;
  cacheEligiblePromptTokens: number;
  cacheHitRate: number | null;
  cacheDataCoverage: number | null;
}

interface UsagePoint {
  bucketStart: string;
  providers: Array<{ providerId: string } & UsageMetrics>;
}

const props = defineProps<{
  metric: "totalTokens" | "requestCount" | "cacheHitRate";
  providers: Array<{ id: string; name: string; color: string }>;
  points: UsagePoint[];
}>();

const host = ref<HTMLElement | null>(null);
const hoverIndex = ref<number | null>(null);
let plot: uPlot | null = null;
let observer: ResizeObserver | null = null;

function compact(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function metricValue(metrics: UsageMetrics): number | null {
  return metrics[props.metric];
}

const hoverPoint = computed(() => {
  const index = hoverIndex.value;
  return index === null ? null : (props.points[index] ?? null);
});

const hoverProviders = computed(() =>
  props.providers.flatMap((provider) => {
    const metrics = hoverPoint.value?.providers.find(
      (item) => item.providerId === provider.id,
    );
    return metrics === undefined ? [] : [{ ...provider, metrics }];
  }),
);

function percentage(value: number | null): string {
  return value === null ? "暂无数据" : `${(value * 100).toFixed(1)}%`;
}

function chartData(): AlignedData {
  const timestamps = props.points.map(
    (point) => Date.parse(point.bucketStart) / 1_000,
  );
  const values = props.providers.map((provider) =>
    props.points.map((point) => {
      const metrics = point.providers.find(
        (item) => item.providerId === provider.id,
      );
      return metrics === undefined ? null : metricValue(metrics);
    }),
  );
  return [timestamps, ...values] as AlignedData;
}

function destroyPlot() {
  plot?.destroy();
  plot = null;
}

function renderPlot() {
  const element = host.value;
  if (element === null || props.points.length === 0) {
    destroyPlot();
    return;
  }
  destroyPlot();
  const percentage = props.metric === "cacheHitRate";
  plot = new uPlot(
    {
      width: Math.max(320, element.clientWidth),
      height: 230,
      cursor: { sync: { key: "bubblepilot-ai-usage" } },
      legend: { show: true, live: true },
      hooks: {
        setCursor: [
          (current) => {
            hoverIndex.value = current.cursor.idx ?? null;
          },
        ],
      },
      scales: {
        x: { time: true },
        y: percentage ? { range: [0, 1] } : {},
      },
      axes: [
        {
          stroke: "#77808d",
          grid: { stroke: "rgba(120, 128, 141, 0.14)", width: 1 },
        },
        {
          stroke: "#77808d",
          grid: { stroke: "rgba(120, 128, 141, 0.14)", width: 1 },
          values: (_u, values) =>
            values.map((value) =>
              percentage ? `${Math.round(value * 100)}%` : compact(value),
            ),
        },
      ],
      series: [
        {},
        ...props.providers.map((provider) => ({
          label: provider.name,
          stroke: provider.color,
          width: 2,
          spanGaps: false,
          points: { show: false },
          value: (_u: uPlot, value: number | null) =>
            value === null
              ? "暂无数据"
              : percentage
                ? `${(value * 100).toFixed(1)}%`
                : value.toLocaleString("zh-CN"),
        })),
      ],
    },
    chartData(),
    element,
  );
}

onMounted(() => {
  void nextTick(renderPlot);
  observer = new ResizeObserver(() => {
    const element = host.value;
    if (plot !== null && element !== null) {
      plot.setSize({ width: Math.max(320, element.clientWidth), height: 230 });
    }
  });
  if (host.value !== null) observer.observe(host.value);
});

watch(
  () => [props.metric, props.providers, props.points],
  () => void nextTick(renderPlot),
  { deep: true },
);

onBeforeUnmount(() => {
  observer?.disconnect();
  destroyPlot();
});
</script>

<template>
  <div class="ai-usage-chart-shell">
    <div
      ref="host"
      class="ai-usage-chart"
      aria-label="AI Provider 用量趋势"
    ></div>
    <div v-if="hoverPoint" class="ai-usage-hover-details">
      <time>{{ new Date(hoverPoint.bucketStart).toLocaleString() }}</time>
      <span
        v-for="provider in hoverProviders"
        :key="provider.id"
        :style="{ '--provider-color': provider.color }"
      >
        <strong>{{ provider.name }}</strong>
        <template v-if="metric === 'totalTokens'">
          总 {{ provider.metrics.totalTokens.toLocaleString("zh-CN") }} · 输入
          {{ provider.metrics.promptTokens.toLocaleString("zh-CN") }} · 输出
          {{ provider.metrics.completionTokens.toLocaleString("zh-CN") }} · 缓存
          {{
            provider.metrics.cachedPromptTokens?.toLocaleString("zh-CN") ??
            "暂无数据"
          }}
        </template>
        <template v-else-if="metric === 'requestCount'">
          {{ provider.metrics.requestCount }} 次 · 成功
          {{ provider.metrics.succeededRequestCount }} · 失败
          {{ provider.metrics.failedRequestCount }}
        </template>
        <template v-else>
          {{ percentage(provider.metrics.cacheHitRate) }} ·
          {{
            provider.metrics.cachedPromptTokens?.toLocaleString("zh-CN") ?? "—"
          }}
          /
          {{
            provider.metrics.cacheEligiblePromptTokens.toLocaleString("zh-CN")
          }}
          Token · 覆盖 {{ percentage(provider.metrics.cacheDataCoverage) }}
        </template>
      </span>
    </div>
  </div>
</template>

<style scoped>
.ai-usage-chart {
  min-height: 230px;
  min-width: 0;
  overflow: hidden;
}
.ai-usage-hover-details {
  display: grid;
  gap: 5px;
  min-height: 24px;
  margin-top: 8px;
  color: var(--bubblepilot-muted);
  font-size: 10px;
  line-height: 1.5;
}

.ai-usage-hover-details time {
  font-weight: 700;
}

.ai-usage-hover-details span {
  padding-left: 9px;
  border-left: 3px solid var(--provider-color);
}

.ai-usage-hover-details strong {
  margin-right: 5px;
  color: var(--bubblepilot-text);
}

.ai-usage-chart :deep(.u-legend) {
  color: var(--bubblepilot-text);
  font-family: inherit;
  font-size: 0.78rem;
}

.ai-usage-chart :deep(.u-value) {
  font-variant-numeric: tabular-nums;
}
</style>
