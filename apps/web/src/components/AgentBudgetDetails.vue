<script setup lang="ts">
import { computed } from "vue";
const props = defineProps<{ summary: unknown }>();
interface Budget {
  settings: {
    version: number;
    maxToolCalls: number;
    maxToolOutputCharacters: number;
    maxToolDurationMs: number;
  };
  modelTurns: number;
  toolCalls: number;
  toolOutputCharacters: number;
  toolDurationMs: number;
  outcome: string;
  reasons: string[];
}
const budget = computed(() => {
  if (
    !props.summary ||
    typeof props.summary !== "object" ||
    !("agentBudget" in props.summary)
  )
    return null;
  const value = props.summary.agentBudget;
  if (
    !value ||
    typeof value !== "object" ||
    !("settings" in value) ||
    !value.settings
  )
    return null;
  return value as Budget;
});
const reasonLabels: Record<string, string> = {
  "tool-calls": "工具调用次数用尽",
  "tool-output": "工具返回内容达到预算",
  "tool-duration": "工具执行时间用尽",
};
</script>
<template>
  <div class="agent-budget-details">
    <template v-if="budget">
      <p>
        Agent：{{
          budget.outcome === "failed"
            ? "执行失败"
            : budget.outcome === "budget-completed"
              ? "预算用尽后完成"
              : "正常完成"
        }}
        · 配置版本 {{ budget.settings.version }}
      </p>
      <p>
        模型 {{ budget.modelTurns }} / {{ budget.settings.maxToolCalls + 2 }} 轮
        · 工具 {{ budget.toolCalls }} / {{ budget.settings.maxToolCalls }} 次
      </p>
      <p>
        工具内容 {{ budget.toolOutputCharacters }} /
        {{ budget.settings.maxToolOutputCharacters }} 字符 · 工具耗时
        {{ (budget.toolDurationMs / 1000).toFixed(2) }} /
        {{ budget.settings.maxToolDurationMs / 1000 }} 秒
      </p>
      <p v-if="budget.reasons?.length">
        收尾原因：{{
          budget.reasons
            .map((reason) => reasonLabels[reason] ?? reason)
            .join("；")
        }}
      </p>
    </template>
    <p v-else>未记录 Agent 预算</p>
  </div>
</template>
<style scoped>
.agent-budget-details {
  color: var(--bubblepilot-muted);
  font-size: 0.875rem;
}
</style>
