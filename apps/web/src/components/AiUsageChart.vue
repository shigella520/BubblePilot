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
import {
  activeUsageProviders,
  hasMetricData,
  usageChartData,
  type UsageMetric,
  type UsagePoint,
  type UsageProvider,
} from "./ai-usage-chart-data";

const props = defineProps<{
  metric: UsageMetric;
  providers: UsageProvider[];
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

const visibleProviders = computed(() =>
  activeUsageProviders(props.providers, props.points, props.metric),
);

const hoverPoint = computed(() => {
  const index = hoverIndex.value;
  return index === null ? null : (props.points[index] ?? null);
});

const hoverProviders = computed(() =>
  visibleProviders.value.flatMap((provider) => {
    const metrics = hoverPoint.value?.providers.find(
      (item) => item.providerId === provider.id,
    );
    return metrics === undefined || !hasMetricData(metrics, props.metric)
      ? []
      : [{ ...provider, metrics }];
  }),
);

function percentage(value: number | null): string {
  return value === null ? "暂无数据" : `${(value * 100).toFixed(1)}%`;
}

function chartData(): AlignedData {
  return usageChartData(
    visibleProviders.value,
    props.points,
    props.metric,
  ) as AlignedData;
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
      width: Math.max(1, Math.floor(element.clientWidth)),
      height: 230,
      cursor: { sync: { key: "bubblepilot-ai-usage" } },
      legend: { show: false },
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
        ...visibleProviders.value.map((provider) => ({
          label: provider.name,
          stroke: provider.color,
          width: 2,
          spanGaps: false,
          points: percentage
            ? { show: true, size: 6, width: 2, stroke: provider.color }
            : { show: false },
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
      plot.setSize({
        width: Math.max(1, Math.floor(element.clientWidth)),
        height: 230,
      });
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
    <div class="usage-series-legend" aria-label="图例">
      <span
        v-for="provider in visibleProviders"
        :key="provider.id"
        :style="{ '--provider-color': provider.color }"
      >
        <i aria-hidden="true"></i>{{ provider.name }}
      </span>
    </div>
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
.ai-usage-chart-shell {
  width: 100%;
  min-width: 0;
  overflow: hidden;
}
.ai-usage-chart {
  min-height: 230px;
  min-width: 0;
  overflow: hidden;
}
.usage-series-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  min-width: 0;
  margin-top: 8px;
  color: var(--bubblepilot-muted);
  font-size: 11px;
  line-height: 1.4;
}

.usage-series-legend span {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  overflow-wrap: anywhere;
}

.usage-series-legend i {
  width: 9px;
  height: 9px;
  margin-right: 5px;
  border: 2px solid var(--provider-color);
  border-radius: 3px;
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
  overflow-wrap: anywhere;
}

.ai-usage-hover-details strong {
  margin-right: 5px;
  color: var(--bubblepilot-text);
}
</style>
