<script setup lang="ts">
import {
  Download,
  FileJson2,
  MessageCircle,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from "@lucide/vue";
import { onMounted, reactive, ref, watch } from "vue";

import SensitiveUnlock from "../components/SensitiveUnlock.vue";
import {
  apiRequest,
  downloadFile,
  errorMessage,
  jsonBody,
} from "../services/api";
import { useSessionStore } from "../stores/session";

interface Chat {
  id: string;
  providerChatId: string;
  displayName: string | null;
  type: string;
  enabled: boolean;
  messageCount: number;
  version: number;
  updatedAt: string;
}

interface MessageResult {
  id: string;
  chatId: string;
  providerChatId: string;
  chatDisplayName: string | null;
  senderId: string | null;
  sentAt: string;
  body: string | null;
  contentRedactedAt: string | null;
  contentType: string;
  isFromMe: boolean;
  executions: Array<{
    id: string;
    triggerName: string;
    workflowName: string;
    workflowVersion: number;
    correlationId: string;
    status: string;
    errorCode: string | null;
  }>;
}
interface DataExportJob {
  id: string;
  scope: {
    chatId: string;
    sentFrom: string;
    sentTo: string;
    types: Array<"messages" | "executions">;
  };
  snapshotAt: string;
  messageCount: number;
  executionCount: number;
  recordCount: number;
  estimatedBytes: number;
  status: "awaiting-confirmation" | "ready" | "revoked" | "expired";
  expiresAt: string;
  downloadedAt: string | null;
  createdAt: string;
}

const session = useSessionStore();
const chats = ref<Chat[]>([]);
const messages = ref<MessageResult[]>([]);
const busy = ref(false);
const message = ref("");
const messageIsError = ref(false);
const exportJobs = ref<DataExportJob[]>([]);
const exportPreview = ref<DataExportJob | null>(null);
const exportConfirmed = ref(false);
const exportPreviewBusy = ref(false);
const exportConfirmBusy = ref(false);
const chatToggleBusyIds = reactive(new Set<string>());
const exportCancelBusyIds = reactive(new Set<string>());
const exportDownloadBusyIds = reactive(new Set<string>());
const form = reactive({
  chatId: "",
  q: "",
  senderId: "",
  sentFrom: "",
  sentTo: "",
});
const exportForm = reactive({
  chatId: "",
  sentFrom: localDateTime(new Date(Date.now() - 24 * 60 * 60 * 1_000)),
  sentTo: localDateTime(new Date()),
  includeMessages: true,
  includeExecutions: true,
});

function localDateTime(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}
function isLongMessage(body: string | null): boolean {
  return (body?.length ?? 0) > 600;
}
function messagePreview(body: string): string {
  return `${body.slice(0, 600)}…`;
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}

async function loadChats() {
  busy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    chats.value = await apiRequest<Chat[]>("/api/v1/chat-monitoring?limit=100");
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    busy.value = false;
  }
}

async function loadExports(): Promise<boolean> {
  try {
    exportJobs.value = await apiRequest<DataExportJob[]>(
      "/api/v1/exports?limit=20",
    );
    return true;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
    return false;
  }
}

async function toggleChat(chat: Chat) {
  if (!session.sensitiveActive || chatToggleBusyIds.has(chat.id)) return;
  chatToggleBusyIds.add(chat.id);
  message.value = "";
  messageIsError.value = false;
  try {
    const updated = await apiRequest<Chat>(
      `/api/v1/chat-monitoring/${chat.id}`,
      {
        method: "PATCH",
        body: jsonBody({
          enabled: !chat.enabled,
          expectedVersion: chat.version,
        }),
      },
    );
    chats.value = chats.value.map((candidate) =>
      candidate.id === updated.id ? updated : candidate,
    );
    message.value = `聊天「${updated.displayName || updated.providerChatId}」已${updated.enabled ? "启用" : "停用"}监听。`;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    chatToggleBusyIds.delete(chat.id);
  }
}

async function search() {
  if (!session.sensitiveActive) return;
  busy.value = true;
  message.value = "";
  messageIsError.value = false;
  const query = new URLSearchParams({ limit: "100" });
  if (form.chatId) query.set("chatId", form.chatId);
  if (form.q) query.set("q", form.q);
  if (form.senderId) query.set("senderId", form.senderId);
  if (form.sentFrom)
    query.set("sentFrom", new Date(form.sentFrom).toISOString());
  if (form.sentTo) query.set("sentTo", new Date(form.sentTo).toISOString());
  try {
    const results = await apiRequest<MessageResult[]>(
      `/api/v1/messages/search?${query}`,
    );
    messages.value = session.sensitiveActive ? results : [];
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    busy.value = false;
  }
}

async function previewExport() {
  if (
    exportPreviewBusy.value ||
    (!exportForm.includeMessages && !exportForm.includeExecutions)
  )
    return;
  exportPreviewBusy.value = true;
  message.value = "";
  messageIsError.value = false;
  exportConfirmed.value = false;
  try {
    exportPreview.value = await apiRequest<DataExportJob>(
      "/api/v1/exports/preview",
      {
        method: "POST",
        body: jsonBody({
          chatId: exportForm.chatId,
          sentFrom: new Date(exportForm.sentFrom).toISOString(),
          sentTo: new Date(exportForm.sentTo).toISOString(),
          types: [
            ...(exportForm.includeMessages ? ["messages"] : []),
            ...(exportForm.includeExecutions ? ["executions"] : []),
          ],
        }),
      },
    );
    const refreshed = await loadExports();
    message.value = refreshed
      ? "已冻结导出范围，请核对记录数后确认生成。"
      : "已冻结导出范围，但列表刷新失败，请稍后刷新。";
    messageIsError.value = !refreshed;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    exportPreviewBusy.value = false;
  }
}

async function confirmExport() {
  if (
    exportPreview.value === null ||
    !exportConfirmed.value ||
    !session.sensitiveActive ||
    exportConfirmBusy.value
  ) {
    return;
  }
  const preview = exportPreview.value;
  exportConfirmBusy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    exportPreview.value = await apiRequest<DataExportJob>(
      `/api/v1/exports/${preview.id}/confirm`,
      {
        method: "POST",
        body: jsonBody({
          expectedRecordCount: preview.recordCount,
          expectedSnapshotAt: preview.snapshotAt,
        }),
      },
    );
    const refreshed = await loadExports();
    message.value = refreshed
      ? "已确认导出，可在有效窗口内下载 JSONL。"
      : "已确认导出，但列表刷新失败，请稍后刷新。";
    messageIsError.value = !refreshed;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    exportConfirmBusy.value = false;
  }
}

async function cancelExport(job: DataExportJob) {
  if (!session.sensitiveActive || exportCancelBusyIds.has(job.id)) return;
  exportCancelBusyIds.add(job.id);
  message.value = "";
  messageIsError.value = false;
  try {
    const revoked = await apiRequest<DataExportJob>(
      `/api/v1/exports/${job.id}`,
      { method: "DELETE" },
    );
    if (exportPreview.value?.id === job.id) exportPreview.value = null;
    exportJobs.value = exportJobs.value.map((item) =>
      item.id === revoked.id ? revoked : item,
    );
    message.value = "已取消本次导出冻结。";
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    exportCancelBusyIds.delete(job.id);
  }
}

async function downloadExport(job: DataExportJob) {
  if (!session.sensitiveActive || exportDownloadBusyIds.has(job.id)) return;
  exportDownloadBusyIds.add(job.id);
  message.value = "";
  messageIsError.value = false;
  try {
    const file = await downloadFile(`/api/v1/exports/${job.id}/download`);
    const url = URL.createObjectURL(file.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.filename;
    anchor.click();
    URL.revokeObjectURL(url);
    const refreshed = await loadExports();
    message.value = refreshed
      ? "导出文件已开始下载。"
      : "导出文件已开始下载，但列表刷新失败，请稍后刷新。";
    messageIsError.value = !refreshed;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    exportDownloadBusyIds.delete(job.id);
  }
}

watch(
  () => session.sensitiveActive,
  (active) => {
    if (active) return;
    messages.value = [];
    exportPreview.value = null;
    exportConfirmed.value = false;
  },
);

onMounted(() => Promise.all([loadChats(), loadExports()]));
</script>

<template>
  <main class="page-container split-admin-page reveal">
    <aside class="admin-sidebar">
      <div>
        <p class="eyebrow">MESSAGES</p>
        <h2>聊天与归档</h2>
      </div>
      <nav>
        <button
          class="active"
          type="button"
          @click="scrollToSection('monitoring')"
        >
          <SlidersHorizontal :size="18" />监听范围
        </button>
        <button type="button" @click="scrollToSection('search')">
          <MessageCircle :size="18" />消息搜索
        </button>
        <button type="button" @click="scrollToSection('export')">
          <FileJson2 :size="18" />数据导出
        </button>
      </nav>
      <div class="sidebar-note">
        监听变更只影响后续消息，不自动回填或删除历史。
      </div>
    </aside>
    <div class="admin-workspace">
      <SensitiveUnlock @verified="search" />
      <p v-if="message" class="form-message" :class="{ error: messageIsError }">
        {{ message }}
      </p>
      <section id="monitoring" class="admin-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">MONITORING</p>
            <h1>聊天监听配置</h1>
          </div>
          <button class="button secondary" type="button" @click="loadChats">
            <RefreshCw :size="16" />刷新
          </button>
        </div>
        <p class="panel-description">
          这里列出 Webhook
          已发现的聊天。启停操作需要二次验证，并使用版本号防止并发覆盖。
        </p>
        <div class="table-shell">
          <table>
            <thead>
              <tr>
                <th>聊天</th>
                <th>类型</th>
                <th>已归档</th>
                <th>最后发现</th>
                <th>监听</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!chats.length">
                <td colspan="5" class="empty-cell">
                  <strong>尚未发现聊天</strong>
                  <span class="empty-help"
                    >聊天列表由 BlueBubbles Webhook 首次投递消息后创建；REST
                    连接验证成功并不代表 Webhook 已连通。</span
                  >
                  <RouterLink class="inline-link" to="/settings"
                    >前往设置检查 BlueBubbles 配置</RouterLink
                  >
                </td>
              </tr>
              <tr v-for="chat in chats" :key="chat.id">
                <td>
                  <strong>{{ chat.displayName || "未命名聊天" }}</strong
                  ><span class="keyline">{{ chat.providerChatId }}</span>
                </td>
                <td>{{ chat.type }}</td>
                <td>{{ chat.messageCount }}</td>
                <td>{{ new Date(chat.updatedAt).toLocaleString() }}</td>
                <td>
                  <button
                    class="switch-button"
                    :class="{ active: chat.enabled }"
                    type="button"
                    :disabled="
                      !session.sensitiveActive || chatToggleBusyIds.has(chat.id)
                    "
                    :aria-busy="chatToggleBusyIds.has(chat.id)"
                    @click="toggleChat(chat)"
                  >
                    <span></span
                    >{{
                      chatToggleBusyIds.has(chat.id)
                        ? "处理中…"
                        : chat.enabled
                          ? "已启用"
                          : "已停用"
                    }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section id="search" class="admin-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">ARCHIVE SEARCH</p>
            <h2>消息搜索</h2>
          </div>
          <span class="state-badge">仅已监听范围</span>
        </div>
        <form class="filter-grid" @submit.prevent="search">
          <label
            ><span>聊天</span
            ><select v-model="form.chatId">
              <option value="">全部已监听聊天</option>
              <option
                v-for="chat in chats.filter((item) => item.enabled)"
                :key="chat.id"
                :value="chat.id"
              >
                {{ chat.displayName || chat.providerChatId }}
              </option>
            </select></label
          >
          <label
            ><span>关键词</span
            ><input
              v-model.trim="form.q"
              type="search"
              maxlength="200"
              placeholder="正文包含…"
          /></label>
          <label
            ><span>发送者</span
            ><input
              v-model.trim="form.senderId"
              type="text"
              maxlength="500"
              placeholder="精确标识"
          /></label>
          <label
            ><span>开始时间</span
            ><input v-model="form.sentFrom" type="datetime-local"
          /></label>
          <label
            ><span>结束时间</span
            ><input v-model="form.sentTo" type="datetime-local"
          /></label>
          <button
            class="button primary"
            type="submit"
            :disabled="busy || !session.sensitiveActive"
          >
            <Search :size="17" />搜索
          </button>
        </form>
        <div v-if="!session.sensitiveActive" class="empty-panel sensitive-mask">
          <Search :size="24" />
          <strong>消息正文已遮蔽</strong>
          <span>完成二次验证后才能搜索和显示归档内容。</span>
        </div>
        <div v-else class="message-results">
          <article v-for="item in messages" :key="item.id">
            <header>
              <strong>{{ item.chatDisplayName || item.providerChatId }}</strong
              ><span>{{ new Date(item.sentAt).toLocaleString() }}</span>
            </header>
            <p v-if="item.contentRedactedAt">【内容已按保留策略清理】</p>
            <template v-else-if="item.body && isLongMessage(item.body)">
              <p class="message-body-collapsed">
                {{ messagePreview(item.body) }}
              </p>
              <details class="message-body-details">
                <summary>展开全文（{{ item.body.length }} 字符）</summary>
                <p>{{ item.body }}</p>
              </details>
            </template>
            <p v-else>{{ item.body || `【${item.contentType}】` }}</p>
            <footer>
              <span>{{
                item.isFromMe ? "我发送" : item.senderId || "未知发送者"
              }}</span>
              <div v-if="item.executions.length" class="message-executions">
                <RouterLink
                  v-for="execution in item.executions"
                  :key="execution.id"
                  class="execution-link"
                  :to="{
                    path: '/executions',
                    query: { executionId: execution.id },
                  }"
                >
                  {{ execution.workflowName }} · v{{
                    execution.workflowVersion
                  }}
                  · {{ execution.status }}
                </RouterLink>
              </div>
              <span v-else>未触发工作流</span>
            </footer>
          </article>
          <div v-if="!messages.length" class="empty-panel">
            <MessageCircle :size="28" /><strong>没有搜索结果</strong
            ><span>调整聊天、关键词、发送者或时间范围后重试。</span>
          </div>
        </div>
      </section>
      <section id="export" class="admin-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">BOUNDED EXPORT</p>
            <h2>受控数据导出</h2>
          </div>
          <span class="state-badge">JSON Lines · 最长 31 天</span>
        </div>
        <p class="panel-description">
          导出必须限定单个已监听聊天和时间范围。系统先冻结范围并计算记录数，确认后提供十分钟下载窗口；文件不包含
          Secret、原始 Webhook Payload 或完整 AI Prompt。
        </p>
        <form class="filter-grid export-form" @submit.prevent="previewExport">
          <label
            ><span>聊天</span
            ><select v-model="exportForm.chatId" required>
              <option value="">请选择已监听聊天</option>
              <option
                v-for="chat in chats.filter((item) => item.enabled)"
                :key="chat.id"
                :value="chat.id"
              >
                {{ chat.displayName || chat.providerChatId }}
              </option>
            </select></label
          ><label
            ><span>开始时间</span
            ><input
              v-model="exportForm.sentFrom"
              type="datetime-local"
              required
          /></label>
          <label
            ><span>结束时间</span
            ><input v-model="exportForm.sentTo" type="datetime-local" required
          /></label>
          <fieldset class="export-types">
            <legend>数据类型</legend>
            <label class="checkbox-field"
              ><input
                v-model="exportForm.includeMessages"
                type="checkbox"
              /><span>消息正文与附件元数据</span></label
            ><label class="checkbox-field"
              ><input
                v-model="exportForm.includeExecutions"
                type="checkbox"
              /><span>执行摘要</span></label
            >
          </fieldset>
          <button
            class="button secondary"
            type="submit"
            :disabled="
              exportPreviewBusy ||
              !exportForm.chatId ||
              (!exportForm.includeMessages && !exportForm.includeExecutions)
            "
            :aria-busy="exportPreviewBusy"
          >
            <FileJson2 :size="17" />{{
              exportPreviewBusy ? "冻结中…" : "预览导出范围"
            }}
          </button>
        </form>
        <article v-if="exportPreview" class="export-preview">
          <header>
            <div>
              <span class="table-status" :class="exportPreview.status">{{
                exportPreview.status
              }}</span>
              <h3>确认冻结范围</h3>
            </div>
            <button
              class="icon-button danger"
              type="button"
              :disabled="
                !session.sensitiveActive ||
                exportCancelBusyIds.has(exportPreview.id)
              "
              :aria-busy="exportCancelBusyIds.has(exportPreview.id)"
              aria-label="取消本次导出"
              @click="cancelExport(exportPreview)"
            >
              <X :size="16" />
            </button>
          </header>
          <div class="export-summary-grid">
            <div>
              <span>消息</span><strong>{{ exportPreview.messageCount }}</strong>
            </div>
            <div>
              <span>执行</span
              ><strong>{{ exportPreview.executionCount }}</strong>
            </div>
            <div>
              <span>总记录</span
              ><strong>{{ exportPreview.recordCount }}</strong>
            </div>
            <div>
              <span>预估大小</span
              ><strong
                >{{
                  Math.ceil(exportPreview.estimatedBytes / 1024)
                }}
                KiB</strong
              >
            </div>
          </div>
          <p>
            快照时间 {{ new Date(exportPreview.snapshotAt).toLocaleString() }} ·
            当前阶段有效至
            {{ new Date(exportPreview.expiresAt).toLocaleTimeString() }}
          </p>
          <label
            v-if="exportPreview.status === 'awaiting-confirmation'"
            class="checkbox-field explicit-confirm"
            ><input v-model="exportConfirmed" type="checkbox" /><span
              >我确认以上聊天、时间范围、数据类型和记录数</span
            ></label
          >
          <div class="form-actions">
            <button
              v-if="exportPreview.status === 'awaiting-confirmation'"
              class="button primary"
              type="button"
              :disabled="
                !exportConfirmed ||
                !session.sensitiveActive ||
                exportConfirmBusy
              "
              :aria-busy="exportConfirmBusy"
              @click="confirmExport"
            >
              <FileJson2 :size="16" />{{
                exportConfirmBusy ? "生成中…" : "确认生成导出"
              }}
            </button>
            <button
              v-if="exportPreview.status === 'ready'"
              class="button primary"
              type="button"
              :disabled="
                !session.sensitiveActive ||
                exportDownloadBusyIds.has(exportPreview.id)
              "
              :aria-busy="exportDownloadBusyIds.has(exportPreview.id)"
              @click="downloadExport(exportPreview)"
            >
              <Download :size="16" />{{
                exportDownloadBusyIds.has(exportPreview.id)
                  ? "下载中…"
                  : "下载 JSONL"
              }}
            </button>
          </div>
        </article>
        <div class="table-shell">
          <table>
            <thead>
              <tr>
                <th>创建时间</th>
                <th>范围</th>
                <th>记录</th>
                <th>状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!exportJobs.length">
                <td colspan="5" class="empty-cell">暂无导出任务</td>
              </tr>
              <tr v-for="job in exportJobs" :key="job.id">
                <td>{{ new Date(job.createdAt).toLocaleString() }}</td>
                <td>
                  {{ job.scope.types.join(" + ") }}
                  <span class="keyline"
                    >{{ new Date(job.scope.sentFrom).toLocaleString() }} —
                    {{ new Date(job.scope.sentTo).toLocaleString() }}</span
                  >
                </td>
                <td>{{ job.recordCount }}</td>
                <td>
                  <span class="table-status" :class="job.status">{{
                    job.status
                  }}</span>
                </td>
                <td>
                  <button
                    v-if="job.status === 'ready'"
                    class="button tiny secondary"
                    type="button"
                    :disabled="
                      !session.sensitiveActive ||
                      exportDownloadBusyIds.has(job.id)
                    "
                    :aria-busy="exportDownloadBusyIds.has(job.id)"
                    @click="downloadExport(job)"
                  >
                    <Download :size="14" />{{
                      exportDownloadBusyIds.has(job.id) ? "下载中…" : "下载"
                    }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </main>
</template>
