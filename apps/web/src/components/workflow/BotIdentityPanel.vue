<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { apiRequest, errorMessage } from "../../services/api";
const props = defineProps<{ workflowId: string }>();
interface Identity {
  nickname: string | null;
  version: number;
  updatedAt: string | null;
  firstNickname: string | null;
}
interface Status {
  summaries: Array<{
    chat_id: string;
    covered_through_index: string;
    bot_summary_rebuild_through: string;
    status: string;
    error_code: string | null;
  }>;
  memoryJobs: Array<{
    id: string;
    chat_id: string;
    status: string;
    cursor_index: string;
    through_index: string;
    error_code: string | null;
  }>;
  preview: {
    total: number;
    matchable: number;
    unknown: number;
    conflicts: number;
    linked: number;
  };
  jobs: Array<{
    id: string;
    status: string;
    processed: number;
    linked: number;
    unknown_count: number;
    conflict_count: number;
    error_code: string | null;
  }>;
  chats: Array<{
    id: string;
    display_name: string | null;
    bot_summary_rebuild_required: boolean;
    bot_memory_rebuild_required: boolean;
    bot_summary_rebuild_through: string | null;
  }>;
}
const identity = ref<Identity | null>(null),
  status = ref<Status | null>(null),
  nickname = ref(""),
  busy = ref(false),
  notice = ref("");
const stateLabel = (value: string | null) =>
  ({
    queued: "等待中",
    running: "处理中",
    succeeded: "已完成",
    failed: "失败",
    superseded: "已失效",
    paused: "已暂停",
    cancelled: "已取消",
  })[value ?? ""] ?? "尚未开始";
let generation = 0;
onBeforeUnmount(() => generation++);
async function load() {
  const token = ++generation;
  identity.value = null;
  status.value = null;
  notice.value = "";
  try {
    const [i, s] = await Promise.all([
      apiRequest<Identity>(
        `/api/v1/workflows/${props.workflowId}/bot-identity`,
      ),
      apiRequest<Status>("/api/v1/bot-attributions"),
    ]);
    if (token !== generation) return;
    identity.value = i;
    nickname.value = i.nickname ?? "";
    status.value = s;
  } catch (e) {
    if (token === generation) notice.value = errorMessage(e);
  }
}
watch(
  () => props.workflowId,
  () => void load(),
  { immediate: true },
);
async function act(path: string, body?: unknown, method = "POST") {
  if (busy.value) return;
  busy.value = true;
  const token = generation;
  try {
    await apiRequest(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (token === generation) {
      await load();
      notice.value = "操作已保存；后台任务可通过刷新查看。";
    }
  } catch (e) {
    if (token === generation) notice.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <details class="role-panel">
    <summary>Bot 角色与历史归属</summary>
    <p>
      一个工作流代表一个稳定角色。改昵称仍是同一角色，换角色请新建工作流。首次昵称自动用于已匹配的旧消息；其他角色的发言共享可见，但不会作为自己的历史回答。
    </p>
    <form
      v-if="identity"
      @submit.prevent="
        act(
          `/api/v1/workflows/${workflowId}/bot-identity`,
          { nickname, expectedVersion: identity.version },
          'PUT',
        )
      "
    >
      <label
        >角色昵称
        <input v-model="nickname" maxlength="120" required :disabled="busy"
      /></label>
      <button :disabled="busy || !nickname.trim()">保存角色昵称</button>
      <span>
        配置版本 {{ identity.version }} ·
        {{ identity.updatedAt ?? "尚未配置" }}</span
      >
    </form>
    <p v-if="notice" role="status">{{ notice }}</p>
    <details class="maintenance">
      <summary>历史归属维护（当前实例）</summary>
      <button type="button" :disabled="busy" @click="load">刷新归属状态</button>
      <template v-if="status"
        ><p>
          当前实例本账号消息 {{ status.preview.total }} 条；可精确匹配
          {{ status.preview.matchable }} 条；已关联
          {{ status.preview.linked }} 条；未知
          {{ status.preview.unknown }} 条；冲突
          {{ status.preview.conflicts }} 条。
        </p>
        <button
          :disabled="busy"
          @click="act('/api/v1/bot-attributions/backfill')"
        >
          启动历史归属回填（不调用模型）
        </button>
        <p>
          旧摘要与索引需手动重建。重建使用现有启用配置和聊天授权，会产生模型用量；未启用的功能保持待重建。
        </p>
        <div v-for="chat in status.chats" :key="chat.id">
          {{ chat.display_name ?? chat.id }} · 摘要
          {{
            chat.bot_summary_rebuild_required
              ? "待重建"
              : chat.bot_summary_rebuild_through
                ? "重建中"
                : "已兼容"
          }}
          · 索引
          {{
            chat.bot_memory_rebuild_required
              ? "待重建"
              : "已放行，详见长期检索任务"
          }}
          <button
            :disabled="busy"
            @click="act(`/api/v1/chats/${chat.id}/bot-identity/rebuild`)"
          >
            启动 / 重试重建
          </button>
        </div>
        <div v-for="item in status.summaries" :key="item.chat_id">
          摘要进度 {{ item.covered_through_index }} /
          {{ item.bot_summary_rebuild_through }} · {{ stateLabel(item.status) }}
          {{ item.error_code }}
        </div>
        <div v-for="item in status.memoryJobs" :key="item.id">
          索引进度 {{ item.cursor_index }} / {{ item.through_index }} ·
          {{ stateLabel(item.status) }} {{ item.error_code }}
        </div>
        <div v-for="job in status.jobs" :key="job.id">
          归属任务 {{ stateLabel(job.status) }} · 已扫描 {{ job.processed }} /
          新关联 {{ job.linked }} · 未知 {{ job.unknown_count }} / 冲突
          {{ job.conflict_count }}
          <span v-if="job.error_code">{{ job.error_code }}</span
          ><button
            v-if="job.status === 'failed'"
            :disabled="busy"
            @click="act(`/api/v1/bot-attributions/${job.id}/retry`)"
          >
            重试
          </button>
        </div>
      </template>
    </details>
  </details>
</template>
<style scoped>
.role-panel {
  margin: 12px 0;
  padding: 12px;
  border: 1px solid var(--color-border, #ddd);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.45);
  font-size: 13px;
}
.role-panel form {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 12px;
  margin: 16px 0;
}
.role-panel label {
  flex: 0 1 320px;
}
.role-panel form span {
  align-self: center;
  color: #667085;
}
.role-panel .maintenance {
  border-top: 1px solid #dde2e8;
  margin-top: 16px;
  padding-top: 14px;
  max-height: 420px;
  overflow: auto;
}
.role-panel button {
  background: #fff;
  border: 1px solid #d4dae2;
  border-radius: 8px;
  cursor: pointer;
}
.role-panel button:disabled {
  opacity: 0.5;
  cursor: default;
}
.role-panel .maintenance > div {
  padding: 8px 0;
  border-bottom: 1px solid #e5e7eb;
}
.role-panel p {
  margin: 10px 0;
}
.role-panel button,
.role-panel input {
  margin: 4px;
  padding: 5px 8px;
}
.role-panel summary {
  cursor: pointer;
  font-weight: 600;
}
</style>
