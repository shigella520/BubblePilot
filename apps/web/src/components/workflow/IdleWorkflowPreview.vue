<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { apiRequest, errorMessage } from "../../services/api";
interface Attempt {
  id: string;
  chatId: string;
  chatName: string | null;
  createdAt: string;
  completedAt: string | null;
  version: number;
  status: string;
  reason: string | null;
  skipReason: string | null;
  requestCount: number;
  requests?: Array<{
    provider: string;
    model: string;
    status: string;
    httpStatus: number | null;
  }>;
  provider: string | null;
  model: string | null;
}
interface Preview {
  chatId: string;
  chatName: string | null;
  lastActivityAt: string | null;
  earliestTriggerAt: string | null;
  reason: string;
  workflowRemaining: number;
  dailyLimit: number;
  latest: Attempt | null;
}
const props = defineProps<{ workflowId: string; version: number | null }>();
const rows = ref<Preview[]>([]),
  attempts = ref<Attempt[]>([]);
const stateError = ref(""),
  historyError = ref("");
const stateBusy = ref(false),
  historyBusy = ref(false),
  hasMore = ref(false);
const offset = ref(0),
  chat = ref("");
const visibleRows = computed(() =>
  rows.value.filter((row) => !chat.value || row.chatId === chat.value),
);
let generation = 0,
  stateTicket = 0,
  historyTicket = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const reasons: Record<string, string> = {
  "chat-unavailable-or-no-activity": "聊天不可用或尚无活动",
  "waiting-for-human": "等待新的真人发言",
  "quiet-hours": "免打扰中",
  "waiting-for-idle": "等待达到空闲时长",
  "daily-limit": "今日额度不足",
  eligible: "符合条件，等待调度",
  running: "执行中",
};
const skipReasons: Record<string, string> = {
  "user-unavailable": "用户希望安静或休息",
  repetitive: "避免重复近期内容",
  "no-suitable-topic": "缺少合适话题",
  "not-recorded": "未记录跳过理由",
};
const states: Record<string, string> = {
  created: "排队中",
  running: "执行中",
  retrying: "重试中",
  succeeded: "发送成功",
  skipped: "已跳过／取消",
  failed: "执行失败",
  "dead-lettered": "执行失败",
  closed: "已关闭",
  unknown: "发送结果未知",
};
function outcome(a: Attempt) {
  return a.reason === "idle-model-skip"
    ? "模型保持安静"
    : (states[a.status] ?? a.status);
}
function time(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}
function duration(a: Attempt) {
  return a.completedAt
    ? `${Math.max(0, (Date.parse(a.completedAt) - Date.parse(a.createdAt)) / 1000).toFixed(1)} 秒`
    : "进行中";
}
async function loadState() {
  const ticket = ++stateTicket,
    current = generation;
  stateBusy.value = true;
  stateError.value = "";
  try {
    const result = await apiRequest<Preview[]>(
      `/api/v1/workflows/${encodeURIComponent(props.workflowId)}/idle-preview`,
    );
    if (current === generation && ticket === stateTicket) rows.value = result;
  } catch (e) {
    if (current === generation && ticket === stateTicket)
      stateError.value = errorMessage(e);
  } finally {
    if (current === generation && ticket === stateTicket)
      stateBusy.value = false;
  }
}
async function loadHistory() {
  const ticket = ++historyTicket,
    current = generation;
  historyBusy.value = true;
  historyError.value = "";
  const query = new URLSearchParams({
    offset: String(offset.value),
    limit: "10",
  });
  if (chat.value) query.set("chatId", chat.value);
  try {
    const result = await apiRequest<{ items: Attempt[]; hasMore: boolean }>(
      `/api/v1/workflows/${encodeURIComponent(props.workflowId)}/idle-history?${query}`,
    );
    if (current === generation && ticket === historyTicket) {
      attempts.value = result.items;
      hasMore.value = result.hasMore;
    }
  } catch (e) {
    if (current === generation && ticket === historyTicket)
      historyError.value = errorMessage(e);
  } finally {
    if (current === generation && ticket === historyTicket)
      historyBusy.value = false;
  }
}
async function refresh() {
  clearTimeout(timer);
  const current = generation;
  await Promise.allSettled([loadState(), loadHistory()]);
  if (current === generation)
    timer = setTimeout(() => {
      void refresh();
    }, 30000);
}
function filter() {
  attempts.value = [];
  hasMore.value = false;
  offset.value = 0;
  void loadHistory();
}
function page(delta: number) {
  offset.value = Math.max(0, offset.value + delta);
  void loadHistory();
}
watch(
  () => [props.workflowId, props.version],
  () => {
    generation++;
    rows.value = [];
    attempts.value = [];
    offset.value = 0;
    chat.value = "";
    void refresh();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  clearTimeout(timer);
});
</script>
<template>
  <section class="idle-dashboard">
    <header class="idle-heading">
      <div>
        <small>PROACTIVE CONVERSATION</small>
        <h2>空闲主动交流</h2>
        <p>当前状态基于已发布版本 · 历史保留各版本记录 · 每 30 秒刷新</p>
      </div>
      <button
        class="button secondary"
        :disabled="stateBusy || historyBusy"
        @click="refresh"
      >
        {{ stateBusy || historyBusy ? "刷新中…" : "刷新状态" }}
      </button>
    </header>
    <div class="idle-shared-filters">
      <slot name="workflow-filter" />
      <label
        >聊天<select v-model="chat" @change="filter">
          <option value="">全部聊天</option>
          <option v-for="row in rows" :key="row.chatId" :value="row.chatId">
            {{ row.chatName || row.chatId }}
          </option>
        </select></label
      >
      <small>筛选同时作用于下方两个表格</small>
    </div>
    <section class="idle-table-panel">
      <h3>
        当前聊天状态 <span>{{ visibleRows.length }} 个聊天</span>
      </h3>
      <p v-if="stateError" role="alert">
        {{ stateError }} <button @click="loadState">重试</button>
      </p>
      <div class="idle-table-scroll">
        <table class="idle-state-table">
          <thead>
            <tr>
              <th>聊天</th>
              <th>当前状态</th>
              <th>最近活动</th>
              <th>下次预计触发</th>
              <th>今日已用 / 上限</th>
              <th>最近尝试</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in visibleRows" :key="row.chatId">
              <td>
                <strong :title="row.chatId">{{
                  row.chatName || row.chatId
                }}</strong>
                <details class="idle-mobile-details">
                  <summary>更多信息</summary>
                  <p>最近活动：{{ time(row.lastActivityAt) }}</p>
                  <p>
                    下次预计：{{
                      row.earliestTriggerAt
                        ? time(row.earliestTriggerAt)
                        : reasons[row.reason]
                    }}
                  </p>
                  <p>
                    今日已用 / 上限：{{
                      row.dailyLimit - row.workflowRemaining
                    }}
                    / {{ row.dailyLimit }}
                  </p>
                  <p>
                    最近尝试：{{
                      row.latest ? outcome(row.latest) : "尚无尝试"
                    }}
                  </p>
                </details>
              </td>
              <td>
                <span
                  class="idle-badge"
                  :class="{ active: row.reason === 'running' }"
                  >{{ reasons[row.reason] || row.reason }}</span
                >
              </td>
              <td>{{ time(row.lastActivityAt) }}</td>
              <td>
                {{
                  row.earliestTriggerAt
                    ? time(row.earliestTriggerAt)
                    : row.reason === "waiting-for-human"
                      ? "等待新的真人发言"
                      : "暂无"
                }}
              </td>
              <td>
                {{ row.dailyLimit - row.workflowRemaining }} /
                {{ row.dailyLimit }}
              </td>
              <td v-if="row.latest">
                {{ outcome(row.latest)
                }}<small>{{ time(row.latest.createdAt) }}</small>
              </td>
              <td v-else>尚无尝试</td>
            </tr>
            <tr v-if="!visibleRows.length">
              <td colspan="6" class="idle-empty">
                {{
                  stateBusy
                    ? "正在读取状态…"
                    : "没有符合筛选条件的已启用聊天。可清除筛选或检查工作流配置。"
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section class="idle-table-panel">
      <div class="idle-heading">
        <h3>历史触发记录</h3>
      </div>
      <p v-if="historyError" role="alert">
        {{ historyError }} <button @click="loadHistory">重试</button>
      </p>
      <div class="idle-table-scroll">
        <table class="idle-history-table">
          <thead>
            <tr>
              <th>触发时间</th>
              <th>聊天 / 版本</th>
              <th>执行结果</th>
              <th>AI 请求</th>
              <th>耗时</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in attempts" :key="a.id">
              <td>
                {{ time(a.createdAt) }}
                <details class="idle-mobile-details">
                  <summary>请求与详情</summary>
                  <p>
                    {{ a.requestCount }} 次请求 ·
                    {{ a.provider || "未调用模型" }} · {{ a.model }}
                  </p>
                  <p>耗时：{{ duration(a) }}</p>
                  <a
                    :href="`/#/executions?executionId=${encodeURIComponent(a.id)}`"
                    >查看执行 ↗</a
                  >
                </details>
              </td>
              <td>
                <strong>{{ a.chatName || a.chatId }}</strong
                ><small>版本 {{ a.version }}</small>
              </td>
              <td>
                <span
                  class="idle-badge"
                  :class="{
                    success: a.status === 'succeeded',
                    danger: ['failed', 'unknown', 'dead-lettered'].includes(
                      a.status,
                    ),
                  }"
                  >{{ outcome(a) }}</span
                ><small v-if="a.reason === 'idle-model-skip'">{{
                  skipReasons[a.skipReason ?? "not-recorded"] ??
                  "未记录跳过理由"
                }}</small
                ><small v-else-if="a.reason">{{ a.reason }}</small>
              </td>
              <td>
                <details v-if="a.requests?.length">
                  <summary>{{ a.requestCount }} 次请求</summary>
                  <p v-for="(request, index) in a.requests" :key="index">
                    {{ index + 1 }}. {{ request.provider }} ·
                    {{ request.model }} ·
                    {{ request.status === "succeeded" ? "成功" : "失败" }}
                    {{ request.httpStatus ?? "" }}
                  </p>
                </details>
                <template v-else>{{ a.requestCount }} 次请求</template
                ><small
                  >{{ a.provider || "未调用模型"
                  }}<template v-if="a.model"> · {{ a.model }}</template></small
                >
              </td>
              <td>{{ duration(a) }}</td>
              <td>
                <a
                  :href="`/#/executions?executionId=${encodeURIComponent(a.id)}`"
                  >查看执行 ↗</a
                >
              </td>
            </tr>
            <tr v-if="!attempts.length">
              <td colspan="6" class="idle-empty">
                {{
                  historyBusy
                    ? "正在读取记录…"
                    : "暂无符合条件的触发记录。周期检查不会产生执行记录。"
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <footer>
        <small
          >仅展示执行元数据；完整请求与响应需在执行详情中敏感解锁查看。</small
        >
        <div>
          <button
            class="button secondary"
            :disabled="historyBusy || offset === 0"
            @click="page(-10)"
          >
            上一页</button
          ><span>第 {{ offset / 10 + 1 }} 页</span
          ><button
            class="button secondary"
            :disabled="historyBusy || !hasMore"
            @click="page(10)"
          >
            下一页
          </button>
        </div>
      </footer>
    </section>
  </section>
</template>
<style scoped>
.idle-dashboard {
  margin: 32px 0;
  display: grid;
  gap: 20px;
  color: var(--text-primary, #252a31);
}
.idle-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
}
.idle-heading h2 {
  margin: 6px 0;
  font-size: 26px;
}
.idle-heading p {
  color: #717780;
  font-size: 13px;
}
.idle-heading small {
  color: #1583da;
  letter-spacing: 1.4px;
  font-weight: 700;
}
.idle-table-panel {
  background: var(--surface, #fff);
  border: 1px solid #e6e7e9;
  border-radius: 20px;
  padding: 24px;
  min-width: 0;
}
.idle-table-panel h3 {
  font-size: 17px;
  margin: 0 0 18px;
}
.idle-table-panel h3 span {
  font-size: 12px;
  color: #858b92;
  font-weight: 400;
  margin-left: 12px;
}
.idle-table-scroll {
  overflow-x: auto;
}
table {
  min-width: 0;
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 13px;
}
th {
  color: #7b8189;
  font-weight: 500;
  padding: 14px 12px;
  background: #f7f8fa;
  white-space: nowrap;
}
td {
  padding: 18px 12px;
  border-bottom: 1px solid #eff0f2;
  vertical-align: top;
  min-width: 125px;
}
td small {
  display: block;
  color: #7b8189;
  font-size: 12px;
  margin-top: 7px;
}
td a {
  color: #1877be;
  white-space: nowrap;
  text-decoration: none;
}
.idle-badge {
  display: inline-block;
  border-radius: 8px;
  padding: 5px 9px;
  background: #f0f2f5;
  color: #59616c;
  font-size: 12px;
  white-space: nowrap;
}
.idle-badge.success {
  background: #e9f6ef;
  color: #267557;
}
.idle-badge.danger {
  background: #fff0eb;
  color: #a14c32;
}
.idle-badge.active {
  background: #eaf3ff;
  color: #247bc0;
}
.idle-empty {
  text-align: center;
  padding: 32px;
  color: #7b8189;
}
.idle-filters {
  display: flex;
  gap: 12px;
  margin-bottom: 14px;
}
.idle-filters label {
  font-size: 12px;
  color: #717780;
}
.idle-filters select {
  margin-left: 8px;
  padding: 8px;
  border: 1px solid #ddd;
  border-radius: 8px;
  background: white;
}
footer {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  align-items: center;
  margin-top: 18px;
  flex-wrap: wrap;
}
footer small {
  color: #7b8189;
}
footer div {
  display: flex;
  align-items: center;
  gap: 12px;
}
footer button {
  padding: 8px 12px;
}
@media (max-width: 640px) {
  .idle-table-panel {
    padding: 16px;
  }
  .idle-heading h2 {
    font-size: 22px;
  }
  .idle-filters {
    flex-wrap: wrap;
  }
  .idle-dashboard {
    margin: 20px 0;
  }
  .idle-table-panel td {
    min-width: 115px;
  }
}
.idle-mobile-details {
  display: none;
}
@media (max-width: 640px) {
  .idle-mobile-details {
    display: block;
    font-size: 12px;
    margin-top: 10px;
    color: #717780;
  }
  .idle-mobile-details summary {
    cursor: pointer;
  }
  .idle-state-table th:nth-child(n + 3),
  .idle-state-table td:nth-child(n + 3),
  .idle-history-table th:nth-child(n + 4),
  .idle-history-table td:nth-child(n + 4) {
    display: none;
  }
  .idle-table-panel td {
    min-width: 0;
    overflow-wrap: anywhere;
    padding: 14px 7px;
  }
  .idle-table-panel th {
    padding: 12px 7px;
  }
  .idle-badge {
    white-space: normal;
  }
}
.idle-shared-filters {
  display: flex;
  align-items: end;
  gap: 14px;
  flex-wrap: wrap;
  padding: 20px;
  border: 1px solid #e6e7e9;
  border-radius: 16px;
  background: var(--surface, #fff);
}
.idle-shared-filters label,
.idle-shared-filters :deep(label) {
  display: grid;
  gap: 7px;
  font-size: 13px;
  color: #717780;
}
.idle-shared-filters input,
.idle-shared-filters select,
.idle-shared-filters :deep(select) {
  padding: 10px 12px;
  border: 1px solid #ddd;
  border-radius: 10px;
  background: white;
  max-width: 100%;
}
.idle-shared-filters small {
  width: 100%;
  color: #7b8189;
}
</style>
