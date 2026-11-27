<script setup lang="ts">
import { formatDateTime } from "../utils/format";
import { computed } from "vue";
import {
  Clock3,
  CircleCheck,
  CircleX,
  CircleMinus,
  CircleSlash,
  CircleHelp,
  CircleAlert,
  LoaderCircle,
  RotateCw,
} from "@lucide/vue";
import {
  executionDurationLabel,
  formatExecutionDuration,
  type ExecutionTiming,
} from "../utils/execution-timing";
const props = defineProps<{
  timing?: ExecutionTiming;
  status?: string;
  compact?: boolean;
}>();
const state = computed(() => {
  switch (props.status) {
    case "succeeded":
      return { icon: CircleCheck, label: "成功", tone: "success" };
    case "failed":
      return { icon: CircleX, label: "失败", tone: "danger" };
    case "dead-lettered":
      return { icon: CircleAlert, label: "重试耗尽", tone: "danger" };
    case "running":
      return { icon: LoaderCircle, label: "运行中", tone: "running" };
    case "retrying":
      return { icon: RotateCw, label: "等待重试", tone: "warning" };
    case "skipped":
      return { icon: CircleMinus, label: "已跳过", tone: "muted" };
    case "closed":
      return { icon: CircleSlash, label: "已关闭", tone: "muted" };
    case "created":
      return { icon: Clock3, label: "待执行", tone: "muted" };
    default:
      return { icon: CircleHelp, label: "状态未知", tone: "muted" };
  }
});
const rows = computed(() =>
  [
    { key: "model" as const, label: "模型请求", note: "含本轮失败尝试与降级" },
    {
      key: "tools" as const,
      label: "工具调用",
      note: "搜索、查询、沙箱与插件",
    },
    { key: "delivery" as const, label: "回复投递", note: "回复节点处理时间" },
    {
      key: "otherNodes" as const,
      label: "其他节点",
      note: "上下文加载等流程步骤",
    },
  ].map((row) => ({ ...row, value: props.timing?.categories[row.key] })),
);
const asOf = computed(() =>
  props.timing ? formatDateTime(props.timing.observedAt) : "未提供统计",
);
</script>

<template>
  <div
    v-if="compact"
    class="execution-duration-cell"
    :title="`截至 ${asOf}；模型和工具为累计调用时间，不与总耗时相加。`"
  >
    <span class="execution-duration-total"
      ><span
        class="execution-duration-state"
        :class="state.tone"
        :title="state.label"
        role="img"
        :aria-label="state.label"
        ><component :is="state.icon" :size="17" aria-hidden="true" /></span
      ><span>{{ executionDurationLabel(timing) }}</span
      ><strong v-if="timing?.unavailableReason !== 'closed'">{{
        formatExecutionDuration(timing?.totalMs)
      }}</strong></span
    >
    <span class="execution-duration-parts"
      ><span
        >模型
        {{ formatExecutionDuration(timing?.categories.model.durationMs) }}</span
      ><span
        >工具
        {{ formatExecutionDuration(timing?.categories.tools.durationMs) }}</span
      ></span
    >
  </div>
  <section v-else class="execution-timing-summary" aria-label="执行耗时概览">
    <div class="execution-timing-heading">
      <h3><Clock3 :size="17" aria-hidden="true" />耗时概览</h3>
      <span>截至 {{ asOf }}</span>
    </div>
    <div class="execution-timing-grid">
      <div class="execution-timing-metric execution-timing-overall">
        <span>{{ executionDurationLabel(timing) }}</span
        ><strong>{{ formatExecutionDuration(timing?.totalMs) }}</strong
        ><small>{{
          timing?.unavailableReason === "closed"
            ? "关闭时间不代表实际完成时间"
            : "实际历时，不含执行前排队"
        }}</small>
      </div>
      <div v-for="row in rows" :key="row.key" class="execution-timing-metric">
        <span>{{ row.label }}</span
        ><strong>{{ formatExecutionDuration(row.value?.durationMs) }}</strong
        ><small>{{ row.note }}</small
        ><small v-if="row.value?.count"
          >已记录 {{ row.value.recordedCount }}/{{ row.value.count }} 项</small
        ><small v-else>暂无耗时记录</small>
      </div>
    </div>
    <p>
      分项是已记录的累计耗时，可能嵌套或重叠，不相加为总耗时。总历时可能包含重试等待；独立后台图片／表情摘要不计入本轮。投递耗时不代表对方设备收件时间。
    </p>
  </section>
</template>

<style scoped>
.execution-duration-cell {
  min-width: 145px;
  display: grid;
  gap: 5px;
  line-height: 1.6;
}
.execution-duration-total,
.execution-duration-parts {
  display: flex;
  flex-wrap: wrap;
  column-gap: 9px;
}
.execution-duration-total {
  align-items: center;
  font-size: 12px;
}
.execution-duration-state {
  display: inline-flex;
  flex-shrink: 0;
}
.execution-duration-state.success {
  color: #19845d;
}
.execution-duration-state.danger {
  color: #c83a38;
}
.execution-duration-state.running {
  color: #226bc0;
}
.execution-duration-state.warning {
  color: #986219;
}
.execution-duration-state.muted {
  color: #737578;
}
.execution-duration-state.running svg {
  animation: execution-status-spin 1.5s linear infinite;
}
@keyframes execution-status-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .execution-duration-state.running svg {
    animation: none;
  }
}
.execution-duration-total strong {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.execution-duration-parts {
  font-size: 11px;
  color: var(--bubblepilot-muted);
}
.execution-duration-parts > span {
  white-space: nowrap;
}
.execution-timing-summary {
  min-width: 0;
  margin-bottom: 18px;
  border: 1px solid var(--bubblepilot-line);
  border-radius: 16px;
  background: #f8fafc;
  padding: 16px;
}
.execution-timing-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 14px;
}
.execution-timing-heading h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}
.execution-timing-heading > span {
  font-size: 11px;
  color: var(--bubblepilot-muted);
  overflow-wrap: anywhere;
}
.execution-timing-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 135px), 1fr));
  gap: 10px;
}
.execution-timing-metric {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 13px;
  border: 1px solid var(--bubblepilot-line);
  border-radius: 12px;
  background: #fff;
  overflow-wrap: anywhere;
}
.execution-timing-metric > span {
  font-size: 12px;
  color: var(--bubblepilot-muted);
}
.execution-timing-metric strong {
  font-size: 20px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}
.execution-timing-metric small {
  font-size: 11px;
  color: var(--bubblepilot-muted);
  line-height: 1.6;
}
.execution-timing-overall {
  background: #eef5fd;
  border-color: #d9e7f5;
}
.execution-timing-summary > p {
  margin: 12px 0 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--bubblepilot-muted);
}
@media (max-width: 600px) {
  .execution-timing-overall {
    grid-column: 1 / -1;
  }
}
</style>
