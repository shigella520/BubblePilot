<script setup lang="ts">
import {
  ArrowUpRight,
  Boxes,
  Workflow,
  RefreshCw,
  CircleAlert,
} from "@lucide/vue";
import { computed } from "vue";
import type { PluginListItem } from "../utils/plugin-overview";

const props = defineProps<{ item: PluginListItem; disabled?: boolean }>();
defineEmits<{ open: [id: string] }>();
const reviewCount = computed(
  () => new Set(props.item.pending_review ?? []).size,
);
const checkedAt = computed(() => {
  const value = props.item.summary?.lastCheckAt;
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date)
    : null;
});
const syncLabel = computed(() => {
  if (!props.item.summary) return "同步状态未提供";
  if (!props.item.summary.servers) return "无需 MCP 工具同步";
  if (!props.item.summary.autoSyncTools) return "自动同步关闭";
  return props.item.enabled ? "自动同步开启" : "自动同步暂停 · 插件已停用";
});
const checkLabel = computed(() => {
  const status = props.item.summary?.lastSyncStatus;
  const label =
    status === "failed"
      ? "检查失败"
      : status === "review"
        ? "检查发现变更"
        : status === "updated"
          ? "已同步工具定义"
          : "已检查工具定义";
  return checkedAt.value
    ? `${label} · ${checkedAt.value}`
    : "尚无自动同步检查记录";
});
</script>

<template>
  <button
    class="plugin-overview-card"
    :disabled="disabled"
    :aria-label="`查看与管理 ${item.name}`"
    @click="$emit('open', item.id)"
  >
    <span class="card-topline">
      <span class="card-icon"><Boxes :size="23" aria-hidden="true" /></span>
      <span class="card-status" :class="{ enabled: item.enabled }">{{
        item.enabled ? "已启用" : "未启用"
      }}</span>
    </span>
    <span class="card-identity">
      <strong class="card-name">{{ item.name }}</strong>
      <span class="card-version">v{{ item.package_version }}</span>
    </span>
    <span
      class="card-description"
      :title="
        item.metadata.description || '暂无插件说明，可进入管理查看具体能力。'
      "
      >{{
        item.metadata.description || "暂无插件说明，可进入管理查看具体能力。"
      }}</span
    >
    <span
      v-if="item.summary"
      class="card-metrics"
      aria-label="已配置的能力数量，不代表实时连接状态"
    >
      <span
        :title="`已批准 ${item.summary.toolsApproved} 个工具，其中 ${item.summary.toolsEnabled} 个未停用；待复核工具请进入管理查看。`"
        ><strong>{{ item.summary.toolsEnabled }}</strong
        ><span>工具已开启</span></span
      >
      <span
        :title="`共 ${item.summary.skillsTotal} 个 Skill，其中 ${item.summary.skillsEnabled} 个已开启。`"
        ><strong>{{ item.summary.skillsEnabled }}</strong
        ><span>Skill 已开启</span></span
      >
      <span
        ><strong>{{ item.summary.servers }}</strong
        ><span>MCP 服务</span></span
      >
    </span>
    <span v-else class="card-missing">能力统计暂未提供</span>
    <span class="card-details">
      <span v-if="item.summary" class="card-detail"
        ><Workflow :size="15" aria-hidden="true" /><span>{{
          item.summary.activeWorkflows
            ? `${item.summary.activeWorkflows} 个启用工作流引用`
            : "暂无启用工作流引用"
        }}</span></span
      >
      <span class="card-detail"
        ><RefreshCw :size="15" aria-hidden="true" /><span>{{
          syncLabel
        }}</span></span
      >
      <span
        v-if="item.summary?.servers"
        class="card-check"
        :title="item.summary.lastCheckAt || undefined"
        >{{ checkLabel }}</span
      >
    </span>
    <span
      v-if="reviewCount || item.summary?.lastSyncStatus === 'failed'"
      class="card-notice"
    >
      <CircleAlert :size="16" aria-hidden="true" />
      <span
        ><span v-if="reviewCount">{{ reviewCount }} 个工具待复核</span
        ><span v-if="item.summary?.lastSyncStatus === 'failed'"
          >{{ reviewCount ? "；" : "" }}最近同步检查失败，原配置保留</span
        ></span
      >
    </span>
    <span class="card-footer"
      ><span>查看与管理</span><ArrowUpRight :size="17" aria-hidden="true"
    /></span>
  </button>
</template>

<style scoped>
.plugin-overview-card {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: stretch;
  padding: 24px;
  border: 1px solid var(--bubblepilot-line);
  border-radius: 22px;
  background: var(--bubblepilot-surface);
  color: var(--bubblepilot-text);
  font: inherit;
  text-align: left;
  white-space: normal;
  cursor: pointer;
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease;
}
.plugin-overview-card:hover:not(:disabled) {
  border-color: #a8c6e8;
  box-shadow: 0 8px 24px rgb(25 62 99 / 7%);
}
.plugin-overview-card:focus-visible {
  outline: 3px solid var(--bubblepilot-accent);
  outline-offset: 3px;
}
.plugin-overview-card:disabled {
  cursor: wait;
  opacity: 0.65;
}
.plugin-overview-card > * {
  min-width: 0;
  max-width: 100%;
}
.card-topline {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.card-icon {
  display: inline-flex;
  padding: 10px;
  border-radius: 13px;
  color: #386897;
  background: #edf4fb;
}
.card-status {
  padding: 4px 10px;
  border-radius: 100px;
  font-size: 12px;
  line-height: 1.5;
  color: #6f6b66;
  background: #f1f0ed;
}
.card-status.enabled {
  background: #eaf6ef;
  color: #24774f;
}
.card-identity {
  display: grid;
  gap: 5px;
}
.card-name {
  font-size: 17px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.card-version {
  font-size: 12px;
  color: var(--bubblepilot-muted);
  overflow-wrap: anywhere;
}
.card-description {
  color: var(--bubblepilot-muted);
  font-size: 13px;
  line-height: 1.7;
  min-height: 3.4em;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  padding: 14px 0;
  border-top: 1px solid var(--bubblepilot-line);
  border-bottom: 1px solid var(--bubblepilot-line);
}
.card-metrics > span {
  min-width: 0;
  display: grid;
  gap: 4px;
  overflow-wrap: anywhere;
}
.card-metrics strong {
  font-size: 21px;
  line-height: 1.3;
  font-variant-numeric: tabular-nums;
}
.card-metrics span span {
  font-size: 11px;
  color: var(--bubblepilot-muted);
  line-height: 1.5;
}
.card-details {
  display: grid;
  gap: 8px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--bubblepilot-muted);
}
.card-detail {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.card-detail svg,
.card-notice svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.card-detail span,
.card-check,
.card-notice {
  min-width: 0;
  overflow-wrap: anywhere;
}
.card-check {
  font-size: 11px;
  padding-left: 23px;
}
.card-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #fff5e8;
  color: #8c5018;
  font-size: 12px;
  line-height: 1.6;
}
.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 15px;
  margin-top: auto;
  border-top: 1px solid var(--bubblepilot-line);
  color: #36648f;
  font-size: 13px;
  font-weight: 600;
}
.card-footer svg {
  flex-shrink: 0;
}
.card-missing {
  color: var(--bubblepilot-muted);
  font-size: 12px;
}
@media (max-width: 480px) {
  .plugin-overview-card {
    padding: 20px;
    gap: 14px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .plugin-overview-card {
    transition: none;
  }
}
</style>
