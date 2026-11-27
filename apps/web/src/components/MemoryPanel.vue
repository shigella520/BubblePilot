<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RefreshCw, Search, Wrench } from "@lucide/vue";
import { confirmAction } from "../services/confirm";
import { apiRequest, errorMessage, jsonBody } from "../services/api";
import { ProgressPoller } from "../services/progress-poller";
import { useSessionStore } from "../stores/session";
import { formatDateTime } from "../utils/format";
import {
  chatHealth,
  isRepairable,
  memoryErrorText,
  memoryHealthPath,
  repairErrorMessage,
  repairNotice,
  type MemoryChatHealth,
  type MemoryHealthView,
} from "../utils/memory-health";
import { memorySearchWarningLabels } from "../utils/memory-tool-diagnostics";
import AdminDetailDialog from "./AdminDetailDialog.vue";
import DismissibleMessage from "./DismissibleMessage.vue";
import LockedHint from "./LockedHint.vue";
import MemoryHealthBadge from "./MemoryHealthBadge.vue";
import MemoryJobsPanel from "./MemoryJobsPanel.vue";
import ToggleSwitch from "./ToggleSwitch.vue";

/** One chat's long-term retrieval (R2): status, 启用 / 修复, test, jobs. */
const props = defineProps<{
  chatId: string;
  /** Archived message count from the chat list, for the enable estimate. */
  messageCount?: number;
}>();
const emit = defineEmits<{
  changed: [state: { chatId: string; enabled: boolean }];
}>();
interface ChatMemoryView {
  enabled: boolean;
  version: number;
  coverage: {
    total: number;
    indexed: number;
    pending: number;
    failed?: number;
  } | null;
}
interface SearchResult {
  status: string;
  retrievalMode: "hybrid" | "keyword-only";
  retrievalId: string;
  reason?: string;
  warnings?: { component: string; code: string; httpStatus?: number }[];
  coverage: { total: number; indexed: number; pending: number };
  evidence: { ref: string; text: string }[];
}
const session = useSessionStore();
const busy = ref(false);
const error = ref("");
const notice = ref("");
const chat = ref<ChatMemoryView | null>(null);
const healthView = ref<MemoryHealthView | null>(null);
const health = computed<MemoryChatHealth | null>(() =>
  chatHealth(healthView.value, props.chatId),
);
const query = ref("");
const result = ref<SearchResult | null>(null);
const source = ref("");
const jobsOpen = ref(false);
const jobsReload = ref(0);
let epoch = 0;
let alive = true;

const enabled = computed(() => chat.value?.enabled ?? false);
const totals = computed(() => {
  const h = health.value;
  if (h && h.enabled && h.state !== "global-off")
    return { total: h.total, indexed: h.indexed, missing: h.missing };
  const c = chat.value?.coverage;
  return c ? { total: c.total, indexed: c.indexed, missing: c.pending } : null;
});
const resultNames: Record<string, string> = {
  succeeded: "检索成功",
  partial: "索引覆盖不完整",
  "no-results": "没有找到匹配结果",
  unavailable: "检索暂不可用",
};
const searchWarnings = computed(() =>
  memorySearchWarningLabels(result.value?.warnings),
);

async function load() {
  const token = epoch;
  const [view, state] = await Promise.all([
    apiRequest<MemoryHealthView>(memoryHealthPath),
    apiRequest<ChatMemoryView>(`/api/v1/chats/${props.chatId}/memory`),
  ]);
  if (!alive || token !== epoch) return;
  healthView.value = view;
  chat.value = state;
}
async function run(action: () => Promise<void>, mapError = errorMessage) {
  if (busy.value) return;
  epoch++;
  poller.invalidate();
  busy.value = true;
  error.value = "";
  const token = epoch;
  try {
    await action();
  } catch (cause) {
    if (alive && token === epoch) error.value = mapError(cause);
  } finally {
    if (alive) busy.value = false;
  }
}
const poller = new ProgressPoller({
  enabled: () =>
    alive &&
    !document.hidden &&
    !busy.value &&
    ["indexing", "service-error"].includes(health.value?.state ?? ""),
  load: () => apiRequest<MemoryHealthView>(memoryHealthPath),
  apply: (view) => {
    healthView.value = view;
  },
  failed: () => undefined,
  intervalMs: 10_000,
});

async function toggle() {
  if (!session.sensitiveActive) return session.requestUnlock();
  if (!chat.value) return;
  const next = !chat.value.enabled;
  const count = chat.value.coverage?.total ?? props.messageCount;
  const ok = next
    ? await confirmAction(
        `启用后将自动为该聊天的全部历史建立索引（约 ${count ?? "未知"} 条消息，会产生向量调用）。${
          healthView.value?.globalEnabled === false
            ? "全局长期检索当前已关闭，开启后才会开始建立索引。"
            : ""
        }`,
        {
          title: "启用此聊天的长期检索？",
          confirmText: "启用并建立索引",
          danger: false,
        },
      )
    : await confirmAction(
        "停用后模型不能再检索这个聊天的长期历史。已建立的索引保留，可随时重新启用。",
        { title: "停用此聊天的长期检索？", confirmText: "停用检索" },
      );
  if (!ok) return;
  const saved = await apiRequest<
    ChatMemoryView & { backfillJobIds?: string[] }
  >(`/api/v1/chats/${props.chatId}/memory`, {
    method: "PUT",
    body: jsonBody({ enabled: next, expectedVersion: chat.value.version }),
  });
  chat.value = saved;
  notice.value = next
    ? saved.backfillJobIds?.length
      ? "已启用长期检索，正在后台为全部历史建立索引。"
      : "已启用长期检索，已有索引直接复用。"
    : "已停用长期检索，已建立的索引保留。";
  emit("changed", { chatId: props.chatId, enabled: next });
  jobsReload.value++;
  await load();
}
async function repair() {
  if (!session.sensitiveActive) return session.requestUnlock();
  const value = await apiRequest<{
    action: "backfill" | "rebuild";
    jobIds: string[];
  }>(`/api/v1/chats/${props.chatId}/memory/repair`, { method: "POST" });
  notice.value = repairNotice(value);
  jobsReload.value++;
  await load();
}
async function search() {
  if (!session.sensitiveActive) return session.requestUnlock();
  const token = epoch;
  const value = await apiRequest<SearchResult>(
    `/api/v1/chats/${props.chatId}/memory/search`,
    { method: "POST", body: jsonBody({ query: query.value }) },
  );
  if (alive && token === epoch && session.sensitiveActive) result.value = value;
}
async function viewSource(ref: string) {
  if (!session.sensitiveActive || !result.value) return;
  const token = epoch;
  const value = await apiRequest<{
    messages: { sentAt: string; senderId: string; text: string }[];
  }>(`/api/v1/memory/retrievals/${result.value.retrievalId}/sources/${ref}`);
  if (alive && token === epoch && session.sensitiveActive)
    source.value = value.messages
      .map((m) => `${formatDateTime(m.sentAt)} ${m.senderId}\n${m.text}`)
      .join("\n\n");
}
function onJobsToggle(event: Event) {
  jobsOpen.value =
    event.target instanceof HTMLDetailsElement && event.target.open;
}

watch(
  () => session.sensitiveActive,
  (active) => {
    if (!active) {
      epoch++;
      poller.invalidate();
      result.value = null;
      source.value = "";
      query.value = "";
    }
  },
);
onMounted(() => {
  void run(load);
  poller.start();
});
onBeforeUnmount(() => {
  alive = false;
  poller.stop();
  result.value = null;
  source.value = "";
});
</script>

<template>
  <section class="memory-panel">
    <DismissibleMessage v-if="error" error inline @close="error = ''">{{
      error
    }}</DismissibleMessage>
    <DismissibleMessage v-else-if="notice" inline @close="notice = ''">{{
      notice
    }}</DismissibleMessage>

    <article class="memory-status-card" aria-label="长期检索状态">
      <header>
        <MemoryHealthBadge :health="chat ? health : undefined" />
        <button
          class="button secondary tiny"
          type="button"
          :disabled="busy"
          @click="run(load)"
        >
          <RefreshCw :size="14" />{{ busy ? "刷新中…" : "刷新" }}
        </button>
      </header>
      <dl v-if="totals" class="memory-status-figures">
        <div>
          <dt>已索引 / 总数</dt>
          <dd>{{ totals.indexed }} / {{ totals.total }} 条</dd>
        </div>
        <div>
          <dt>缺失</dt>
          <dd>{{ totals.missing }} 条</dd>
        </div>
        <div v-if="health?.progress">
          <dt>进行中任务</dt>
          <dd>
            {{ health.progress.done }} / {{ health.progress.total }} 条 ·
            {{ health.progress.percent }}%
          </dd>
        </div>
      </dl>
      <progress
        v-if="health?.progress"
        :value="health.progress.percent"
        max="100"
        aria-label="索引进度"
      ></progress>
      <p v-if="health?.error" class="memory-status-error">
        最近错误：{{
          memoryErrorText(
            health.error.code,
            health.error.detail,
            health.error.at,
          )
        }}
      </p>
      <p v-if="health?.retryAt" class="panel-description">
        下次自动重试：{{ formatDateTime(health.retryAt) }}
      </p>
      <p v-if="health?.state === 'global-off'" class="panel-description">
        全局长期检索已关闭，请到
        <RouterLink :to="{ path: '/ai', hash: '#memory-settings' }"
          >AI 服务 → 长期检索</RouterLink
        >
        开启。
      </p>
      <p
        v-else-if="health?.state === 'rebuild-required'"
        class="panel-description"
      >
        角色昵称或归属已变化，需要重建该聊天的索引；点击“修复”启动归属重建（会产生模型用量）。
      </p>
      <p
        v-else-if="health?.state === 'service-error'"
        class="panel-description"
      >
        向量服务最近一次索引失败，系统会自动重试；点击“修复”会先测试连接，成功后立即重试。
      </p>
    </article>

    <div class="memory-main-actions">
      <div class="memory-enable">
        <div>
          <strong>启用长期检索</strong>
          <p class="panel-description">
            {{
              enabled
                ? "AI 可按问题检索该聊天的历史。停用后已建立的索引保留，可随时重新启用。"
                : "启用后自动为全部历史建立索引，AI 才能检索该聊天的历史。"
            }}
          </p>
        </div>
        <ToggleSwitch
          :model-value="enabled"
          label="启用长期检索"
          :disabled="busy || !chat"
          @update:model-value="run(toggle)"
        />
      </div>
      <button
        v-if="isRepairable(health)"
        class="button primary"
        type="button"
        :disabled="busy"
        @click="run(repair, repairErrorMessage)"
      >
        <Wrench :size="16" />{{ busy ? "处理中…" : "修复" }}
      </button>
      <LockedHint compact reason="启用、修复和检索测试需要敏感操作授权" />
    </div>

    <section class="memory-search">
      <h3>检索测试</h3>
      <form class="memory-search-form" @submit.prevent="run(search)">
        <label
          ><span>测试问题</span
          ><input
            v-model="query"
            maxlength="500"
            placeholder="例如：上次聚会定在哪里？"
            :disabled="busy || !enabled || !session.sensitiveActive"
        /></label>
        <button
          class="button secondary"
          type="submit"
          :disabled="
            busy || !enabled || !query.trim() || !session.sensitiveActive
          "
        >
          <Search :size="16" />测试检索
        </button>
      </form>
      <p v-if="!enabled" class="panel-description">启用后才能测试检索。</p>
      <div
        v-if="result && session.sensitiveActive"
        class="memory-search-result"
      >
        <p>
          <strong>{{ resultNames[result.status] ?? result.status }}</strong> ·
          检索方式：{{
            result.retrievalMode === "hybrid" ? "向量 + 关键词" : "仅关键词"
          }}
          · 命中 {{ result.evidence.length }} 条
        </p>
        <p
          v-for="item in searchWarnings"
          :key="item"
          class="memory-status-error"
        >
          {{ item }}
        </p>
        <p
          v-if="result.reason === 'retrieval-unavailable'"
          class="panel-description"
        >
          向量和关键词检索都未完成，不能据此判断没有相关历史。
        </p>
        <p v-if="result.coverage.pending" class="panel-description">
          还有
          {{ result.coverage.pending }} 条消息尚未建立索引，结果可能不完整。
        </p>
        <article v-for="item in result.evidence" :key="item.ref">
          <p>
            {{ item.text.slice(0, 200) }}{{ item.text.length > 200 ? "…" : "" }}
          </p>
          <button
            class="button tiny secondary"
            type="button"
            :disabled="busy"
            @click="run(() => viewSource(item.ref))"
          >
            查看来源 {{ item.ref }}
          </button>
        </article>
      </div>
      <AdminDetailDialog
        v-if="source && session.sensitiveActive"
        title="历史来源原文"
        size="md"
        @close="source = ''"
      >
        <pre class="memory-source">{{ source }}</pre>
      </AdminDetailDialog>
    </section>

    <details class="advanced-settings" @toggle="onJobsToggle">
      <summary>最近任务</summary>
      <MemoryJobsPanel
        v-if="jobsOpen"
        :chat-id="chatId"
        :reload-token="jobsReload"
      />
    </details>
  </section>
</template>

<style scoped>
.memory-panel {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.memory-status-card {
  display: grid;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--bubblepilot-line);
  border-radius: 16px;
  background: var(--bubblepilot-surface-subtle);
}
.memory-status-card header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.memory-status-card .memory-health {
  font-size: var(--bubblepilot-text-lg);
}
.memory-status-figures {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr));
  gap: 10px;
  margin: 0;
}
.memory-status-figures dt {
  color: var(--bubblepilot-muted);
  font-size: var(--bubblepilot-text-sm);
}
.memory-status-figures dd {
  margin: 4px 0 0;
  font-weight: 700;
}
.memory-status-card progress {
  width: 100%;
  height: 0.6rem;
  accent-color: var(--bubblepilot-accent);
}
.memory-status-card p,
.memory-search p {
  margin: 0;
}
.memory-status-error {
  color: var(--bubblepilot-danger);
  overflow-wrap: anywhere;
}
.memory-main-actions {
  display: grid;
  gap: 10px;
}
.memory-main-actions > .button {
  justify-self: start;
}
.memory-enable {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.memory-enable .panel-description {
  margin: 4px 0 0;
}
.memory-search {
  display: grid;
  gap: 10px;
}
.memory-search h3 {
  margin: 0;
}
.memory-search-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 10px;
}
.memory-search-result {
  display: grid;
  gap: 8px;
}
.memory-search-result article {
  display: grid;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--bubblepilot-line);
}
.memory-search-result article .button {
  justify-self: start;
}
.memory-source {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
@media (max-width: 680px) {
  .memory-search-form {
    grid-template-columns: 1fr;
  }
}
</style>
