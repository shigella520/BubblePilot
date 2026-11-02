<script setup lang="ts">
import { ref, watch } from "vue";
import { apiRequest, errorMessage } from "../../services/api";
const props = defineProps<{ workflowId: string; version: number | null }>();
interface Preview {
  chatId: string;
  lastActivityAt: string | null;
  earliestTriggerAt: string | null;
  quiet: boolean;
  reason: string;
  workflowRemaining: number;
  instanceRemaining: number;
}
const rows = ref<Preview[]>([]),
  error = ref("");
const busy = ref(false);
let generation = 0;
watch(
  () => [props.workflowId, props.version],
  () => {
    generation++;
    rows.value = [];
    error.value = "";
    busy.value = false;
  },
);
const reasons: Record<string, string> = {
  "chat-unavailable-or-no-activity": "聊天不可用或尚无活动",
  "waiting-for-human": "等待新的真人发言",
  "quiet-hours": "免打扰中",
  "waiting-for-idle": "等待达到空闲时长",
  "daily-limit": "今日额度不足",
  eligible: "符合条件，等待调度",
};
async function load() {
  if (busy.value) return;
  const ticket = ++generation;
  busy.value = true;
  error.value = "";
  try {
    const result = await apiRequest<Preview[]>(
      `/api/v1/workflows/${encodeURIComponent(props.workflowId)}/idle-preview`,
    );
    if (ticket === generation) rows.value = result;
  } catch (cause) {
    if (ticket === generation) error.value = errorMessage(cause);
  } finally {
    if (ticket === generation) busy.value = false;
  }
}
</script>
<template>
  <details class="admin-panel">
    <summary>空闲主动交流状态（当前已启用版本）</summary>
    <p>只读检查，不调用模型或发送消息。编辑中的配置须保存并启用后生效。</p>
    <button
      class="button secondary"
      :disabled="busy"
      type="button"
      @click="load"
    >
      {{ busy ? "检查中…" : "检查当前状态" }}
    </button>
    <p v-if="error" role="alert">{{ error }}</p>
    <article v-for="row in rows" :key="row.chatId">
      <strong>{{ row.chatId }}</strong>
      <p>{{ reasons[row.reason] ?? row.reason }}</p>
      <p>
        最近活动：{{
          row.lastActivityAt
            ? new Date(row.lastActivityAt).toLocaleString()
            : "无"
        }}；预计最早触发：{{
          row.earliestTriggerAt
            ? new Date(row.earliestTriggerAt).toLocaleString()
            : "暂无"
        }}
      </p>
      <p>
        今日剩余：本工作流 {{ row.workflowRemaining }} 次，实例
        {{ row.instanceRemaining }} 次
      </p>
    </article>
  </details>
</template>
