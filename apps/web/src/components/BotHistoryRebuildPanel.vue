<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { apiRequest, errorMessage } from "../services/api";
const props = defineProps<{ target: "summary" | "memory" }>();
interface Status {
  chats: Array<{
    id: string;
    display_name: string | null;
    bot_summary_rebuild_required: boolean;
    bot_memory_rebuild_required: boolean;
    bot_summary_rebuild_through: string | null;
  }>;
  summaries: Array<{
    chat_id: string;
    display_name: string | null;
    covered_through_index: string;
    bot_summary_rebuild_through: string;
    status: string | null;
    error_code: string | null;
  }>;
  memoryJobs: Array<{
    id: string;
    chat_id: string;
    display_name: string | null;
    status: string;
    cursor_index: string;
    through_index: string;
    error_code: string | null;
  }>;
}
const data = ref<Status | null>(null),
  busy = ref(false),
  notice = ref("");
let alive = true;
onBeforeUnmount(() => {
  alive = false;
});
const label = computed(() => (props.target === "summary" ? "摘要" : "索引"));
const chats = computed(
  () =>
    data.value?.chats.filter((c) =>
      props.target === "summary"
        ? c.bot_summary_rebuild_required || c.bot_summary_rebuild_through
        : c.bot_memory_rebuild_required,
    ) ?? [],
);
async function refresh() {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await apiRequest<Status>("/api/v1/bot-attributions");
    if (alive) data.value = result;
  } catch (e) {
    if (alive) notice.value = errorMessage(e);
  } finally {
    if (alive) busy.value = false;
  }
}
async function rebuild(id: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await apiRequest<{ summary: boolean; memory: boolean }>(
      `/api/v1/chats/${id}/bot-identity/rebuild`,
      { method: "POST", body: JSON.stringify({ target: props.target }) },
    );
    if (!alive) return;
    notice.value = result[props.target]
      ? `${label.value}重建已启动，请刷新查看进度。`
      : `未启动${label.value}重建，请检查对应服务配置及聊天授权。`;
    const updated = await apiRequest<Status>("/api/v1/bot-attributions");
    if (alive) data.value = updated;
  } catch (e) {
    if (alive) notice.value = errorMessage(e);
  } finally {
    if (alive) busy.value = false;
  }
}
const stateLabel = (s: string | null) =>
  ({
    queued: "等待中",
    running: "处理中",
    succeeded: "已完成",
    failed: "失败",
    superseded: "已失效",
    paused: "已暂停",
    cancelled: "已取消",
  })[s ?? ""] ?? "尚未开始";
onMounted(refresh);
</script>
<template>
  <section
    :id="target === 'summary' ? 'summary-rebuild' : 'index-rebuild'"
    class="admin-panel rebuild-panel"
    tabindex="-1"
  >
    <div class="panel-head">
      <h2>重建{{ label }}</h2>
      <button class="button secondary" :disabled="busy" @click="refresh">
        {{ busy ? "处理中…" : "刷新状态" }}
      </button>
    </div>
    <p>
      角色归属调整后，在这里重建聊天的{{
        label
      }}。请先完成角色昵称配置与历史归属回填；重建会调用已配置模型并产生用量。
    </p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="data && !chats.length">
      暂无待启动的{{ label }}重建，已启动任务见下方进度。
    </p>
    <div v-for="chat in chats" :key="chat.id" class="rebuild-row">
      <span>{{ chat.display_name ?? chat.id }}</span
      ><button
        class="button secondary"
        :disabled="busy"
        @click="rebuild(chat.id)"
      >
        启动 / 重试{{ label }}重建
      </button>
    </div>
    <template v-if="data && target === 'summary'"
      ><p v-for="item in data.summaries" :key="item.chat_id">
        {{ item.display_name ?? item.chat_id }} ·
        {{ item.covered_through_index }} /
        {{ item.bot_summary_rebuild_through }} · {{ stateLabel(item.status) }}
        {{ item.error_code }}
      </p></template
    >
    <template v-if="data && target === 'memory'"
      ><div v-for="item in data.memoryJobs" :key="item.id" class="rebuild-row">
        <span
          >{{ item.display_name ?? item.chat_id }} · {{ item.cursor_index }} /
          {{ item.through_index }} · {{ stateLabel(item.status) }}
          {{ item.error_code }}</span
        ><button
          v-if="item.status === 'failed'"
          class="button secondary"
          :disabled="busy"
          @click="rebuild(item.chat_id)"
        >
          重试索引重建
        </button>
      </div></template
    >
  </section>
</template>
<style scoped>
.rebuild-panel {
  scroll-margin-top: 120px;
}
.rebuild-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid #e0e4e8;
  flex-wrap: wrap;
}
.rebuild-row span {
  overflow-wrap: anywhere;
}
</style>
