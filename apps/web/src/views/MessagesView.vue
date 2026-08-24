<script setup lang="ts">
import {
  Download,
  FileJson2,
  Images,
  MessageCircle,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from "@lucide/vue";
import { onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import CursorPagination from "../components/CursorPagination.vue";
import SensitiveUnlock from "../components/SensitiveUnlock.vue";
import DismissibleMessage from "../components/DismissibleMessage.vue";
import { useCursorPager } from "../composables/useCursorPager";
import {
  apiAllPages,
  apiPageRequest,
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
  attachments: Array<{
    providerAttachmentId: string;
    mimeType: string | null;
    fileName: string | null;
    sizeBytes: number | null;
  }>;
  linkPreview: {
    status: string;
    errorCode: string | null;
    items: Array<{
      source: "bluebubbles" | "open-graph";
      url: string;
      originalUrl: string | null;
      title: string | null;
      summary: string | null;
      siteName: string | null;
      imageAvailable: boolean;
      imageUrl: string | null;
      iconAvailable: boolean;
    }>;
  };
  linkPreviewDiagnostics: Array<{
    source: string;
    attempt: number;
    status: string;
    durationMs: number;
    httpStatus: number | null;
    code: string | null;
  }>;
  linkPreviewFetchedAt: string | null;
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

type ImageSummaryStatus =
  | "not-created"
  | "pending"
  | "processing"
  | "succeeded"
  | "failed"
  | "unavailable"
  | "redacted";

interface MessageMediaDetail {
  messageId: string;
  contentRedactedAt: string | null;
  items: Array<{
    attachmentRef: string;
    sourceType: "attachment" | "link-preview";
    label: string;
    fileName: string | null;
    declaredMimeType: string | null;
    sizeBytes: number | null;
    summaryStatus: ImageSummaryStatus;
    summary: string | null;
    providerName: string | null;
    model: string | null;
    contractVersion: string | null;
    attemptCount: number;
    errorCode: string | null;
    durationMs: number | null;
    generatedAt: string | null;
    imageContentHash: string | null;
    previewUrl: string;
  }>;
}

interface ChatParticipant {
  senderId: string;
  realName: string | null;
  nickname: string | null;
  messageCount: number;
  lastSeenAt: string;
}

interface ChatParticipantSet {
  chatId: string;
  version: number;
  participants: ChatParticipant[];
}

interface ChatParticipantDraft extends Omit<
  ChatParticipant,
  "realName" | "nickname"
> {
  realName: string;
  nickname: string;
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
const busy = ref(false);
const message = ref("");
const messageIsError = ref(false);
const chatOptions = ref<Chat[]>([]);
const exportPreview = ref<DataExportJob | null>(null);
const exportConfirmed = ref(false);
const exportPreviewBusy = ref(false);
const exportConfirmBusy = ref(false);
const chatToggleBusyIds = reactive(new Set<string>());
const chatDeleteBusyIds = reactive(new Set<string>());
const participantChat = ref<Chat | null>(null);
const participantVersion = ref(0);
const participantDrafts = ref<ChatParticipantDraft[]>([]);
const participantBusy = ref(false);
const participantSaveBusy = ref(false);
const mediaMessage = ref<MessageResult | null>(null);
const mediaDetail = ref<MessageMediaDetail | null>(null);
const mediaBusy = ref(false);
const mediaError = ref("");
const failedMediaPreviews = reactive(new Set<string>());
const exportCancelBusyIds = reactive(new Set<string>());
const exportDownloadBusyIds = reactive(new Set<string>());
const form = reactive({
  chatId: "",
  q: "",
  senderId: "",
  sentFrom: "",
  sentTo: "",
});
const appliedSearch = reactive({ ...form });
const exportForm = reactive({
  chatId: "",
  sentFrom: localDateTime(new Date(Date.now() - 24 * 60 * 60 * 1_000)),
  sentTo: localDateTime(new Date()),
  includeMessages: true,
  includeExecutions: true,
});
const chatPager = useCursorPager<Chat>((cursor) => {
  const query = new URLSearchParams({ limit: "25" });
  if (cursor !== null) query.set("cursor", cursor);
  return apiPageRequest<Chat[]>(`/api/v1/chat-monitoring?${query}`);
});
const messagePager = useCursorPager<MessageResult>((cursor) => {
  const query = new URLSearchParams({ limit: "50" });
  if (appliedSearch.chatId) query.set("chatId", appliedSearch.chatId);
  if (appliedSearch.q) query.set("q", appliedSearch.q);
  if (appliedSearch.senderId) query.set("senderId", appliedSearch.senderId);
  if (appliedSearch.sentFrom) {
    query.set("sentFrom", new Date(appliedSearch.sentFrom).toISOString());
  }
  if (appliedSearch.sentTo) {
    query.set("sentTo", new Date(appliedSearch.sentTo).toISOString());
  }
  if (cursor !== null) query.set("cursor", cursor);
  return apiPageRequest<MessageResult[]>(`/api/v1/messages/search?${query}`);
});
const exportPager = useCursorPager<DataExportJob>((cursor) => {
  const query = new URLSearchParams({ limit: "10" });
  if (cursor !== null) query.set("cursor", cursor);
  return apiPageRequest<DataExportJob[]>(`/api/v1/exports?${query}`);
});
const chats = chatPager.items;
const messages = messagePager.items;
const exportJobs = exportPager.items;

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

function isImageAttachment(item: MessageResult["attachments"][number]) {
  if (item.mimeType?.toLowerCase().startsWith("image/")) return true;
  return /\.(?:jpe?g|png|webp|gif|heic|heif)$/iu.test(item.fileName ?? "");
}

function hasImageMedia(item: MessageResult): boolean {
  return (
    item.attachments.some(isImageAttachment) ||
    item.linkPreview.items.some((preview) => preview.imageUrl !== null)
  );
}

function imageSummaryStatusLabel(status: ImageSummaryStatus): string {
  return {
    "not-created": "未创建摘要任务",
    pending: "等待生成",
    processing: "生成中",
    succeeded: "摘要成功",
    failed: "摘要失败",
    unavailable: "原图不可用",
    redacted: "已按保留策略清理",
  }[status];
}

function imageSummaryStatusDescription(status: ImageSummaryStatus): string {
  return {
    "not-created": "这通常是功能上线前入库的历史图片，不会自动回填摘要。",
    pending: "任务已保存，正在等待后台 Worker 处理。",
    processing: "视觉 Provider 正在生成摘要。",
    succeeded: "摘要已保存，图片退出历史图片范围后会使用这段内容。",
    failed: "Provider 请求或摘要输出校验失败。",
    unavailable: "原始图片无法读取，因此不能生成可信摘要。",
    redacted: "图片和摘要已按消息保留策略清理。",
  }[status];
}

function formatMediaBytes(value: number | null): string {
  if (value === null) return "大小未知";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function closeMessageMedia() {
  mediaMessage.value = null;
  mediaDetail.value = null;
  mediaError.value = "";
  failedMediaPreviews.clear();
}

async function loadMessageMedia() {
  if (mediaMessage.value === null) return;
  mediaBusy.value = true;
  mediaError.value = "";
  failedMediaPreviews.clear();
  try {
    mediaDetail.value = await apiRequest<MessageMediaDetail>(
      `/api/v1/messages/${encodeURIComponent(mediaMessage.value.id)}/media`,
    );
  } catch (cause) {
    mediaError.value = errorMessage(cause);
  } finally {
    mediaBusy.value = false;
  }
}

function openMessageMedia(item: MessageResult) {
  mediaMessage.value = item;
  mediaDetail.value = null;
  failedMediaPreviews.clear();
  void loadMessageMedia();
}

function handleMediaKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && mediaMessage.value !== null) {
    closeMessageMedia();
  }
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}

async function loadChatOptions() {
  chatOptions.value = await apiAllPages<Chat>("/api/v1/chats?limit=100");
}

async function loadChats(reset = false) {
  busy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    await Promise.all([
      reset ? chatPager.first() : chatPager.refresh(),
      loadChatOptions(),
    ]);
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    busy.value = false;
  }
}

async function loadExports(reset = false): Promise<boolean> {
  try {
    await (reset ? exportPager.first() : exportPager.refresh());
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
    chatOptions.value = updated.enabled
      ? [
          updated,
          ...chatOptions.value.filter(
            (candidate) => candidate.id !== updated.id,
          ),
        ]
      : chatOptions.value.filter((candidate) => candidate.id !== updated.id);
    message.value = `聊天「${updated.displayName || updated.providerChatId}」已${updated.enabled ? "启用" : "停用"}监听。`;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    chatToggleBusyIds.delete(chat.id);
  }
}

async function deleteChat(chat: Chat) {
  if (
    chat.enabled ||
    !session.sensitiveActive ||
    chatDeleteBusyIds.has(chat.id)
  ) {
    return;
  }
  const label = chat.displayName || chat.providerChatId;
  if (
    !window.confirm(`确认删除聊天「${label}」？历史消息和执行记录仍会保留。`)
  ) {
    return;
  }
  chatDeleteBusyIds.add(chat.id);
  message.value = "";
  messageIsError.value = false;
  try {
    await apiRequest<void>(
      `/api/v1/chats/${chat.id}?expectedVersion=${chat.version}`,
      { method: "DELETE" },
    );
    chats.value = chats.value.filter((candidate) => candidate.id !== chat.id);
    chatOptions.value = chatOptions.value.filter(
      (candidate) => candidate.id !== chat.id,
    );
    if (participantChat.value?.id === chat.id) {
      closeParticipantEditor();
    }
    message.value = `聊天「${label}」已删除，历史记录和引用仍会保留。`;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    chatDeleteBusyIds.delete(chat.id);
  }
}

function applyParticipantSet(value: ChatParticipantSet) {
  participantVersion.value = value.version;
  participantDrafts.value = value.participants.map((participant) => ({
    ...participant,
    realName: participant.realName ?? "",
    nickname: participant.nickname ?? "",
  }));
}

function closeParticipantEditor() {
  participantChat.value = null;
  participantVersion.value = 0;
  participantDrafts.value = [];
}

async function editParticipants(chat: Chat) {
  if (!session.sensitiveActive || participantBusy.value) return;
  if (participantChat.value?.id === chat.id) {
    closeParticipantEditor();
    return;
  }
  participantBusy.value = true;
  participantChat.value = chat;
  participantDrafts.value = [];
  message.value = "";
  messageIsError.value = false;
  try {
    const updated = await apiRequest<ChatParticipantSet>(
      `/api/v1/chats/${chat.id}/participants`,
    );
    if (participantChat.value?.id === chat.id) applyParticipantSet(updated);
  } catch (cause) {
    closeParticipantEditor();
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    participantBusy.value = false;
  }
}

async function saveParticipants() {
  const chat = participantChat.value;
  if (chat === null || !session.sensitiveActive || participantSaveBusy.value) {
    return;
  }
  participantSaveBusy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    const identities = participantDrafts.value.flatMap((participant) => {
      const realName = participant.realName.trim();
      const nickname = participant.nickname.trim();
      return realName.length === 0 && nickname.length === 0
        ? []
        : [
            {
              senderId: participant.senderId,
              realName: realName.length === 0 ? null : realName,
              nickname: nickname.length === 0 ? null : nickname,
            },
          ];
    });
    const updated = await apiRequest<ChatParticipantSet>(
      `/api/v1/chats/${chat.id}/participants`,
      {
        method: "PUT",
        body: jsonBody({
          expectedVersion: participantVersion.value,
          identities,
        }),
      },
    );
    if (participantChat.value?.id === chat.id) applyParticipantSet(updated);
    message.value = `聊天「${chat.displayName || chat.providerChatId}」的成员映射已保存。`;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    participantSaveBusy.value = false;
  }
}

async function search() {
  if (!session.sensitiveActive) return;
  busy.value = true;
  message.value = "";
  messageIsError.value = false;
  Object.assign(appliedSearch, form);
  try {
    await messagePager.first();
    if (!session.sensitiveActive) messagePager.clear();
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    busy.value = false;
  }
}

async function changePage(action: () => Promise<boolean>) {
  message.value = "";
  messageIsError.value = false;
  try {
    await action();
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
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
    const refreshed = await loadExports(true);
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
    messagePager.clear();
    exportPreview.value = null;
    exportConfirmed.value = false;
    closeParticipantEditor();
    closeMessageMedia();
  },
);

onMounted(() => {
  document.addEventListener("keydown", handleMediaKeydown);
  void Promise.all([loadChats(true), loadExports(true)]);
});
onBeforeUnmount(() =>
  document.removeEventListener("keydown", handleMediaKeydown),
);
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
      <DismissibleMessage
        v-if="message"
        :error="messageIsError"
        @close="message = ''"
        >{{ message }}</DismissibleMessage
      >
      <section id="monitoring" class="admin-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">MONITORING</p>
            <h1>聊天监听配置</h1>
          </div>
          <button
            class="button secondary"
            type="button"
            @click="loadChats(false)"
          >
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
                <th>成员身份</th>
                <th>监听</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!chats.length">
                <td colspan="7" class="empty-cell">
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
                    class="button secondary tiny"
                    type="button"
                    :disabled="
                      !session.sensitiveActive ||
                      participantBusy ||
                      participantSaveBusy
                    "
                    :aria-busy="
                      participantBusy && participantChat?.id === chat.id
                    "
                    @click="editParticipants(chat)"
                  >
                    <Users :size="15" />
                    {{
                      participantBusy && participantChat?.id === chat.id
                        ? "读取中…"
                        : participantChat?.id === chat.id
                          ? "收起"
                          : "成员映射"
                    }}
                  </button>
                </td>
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
                <td>
                  <button
                    class="button tiny secondary"
                    type="button"
                    :disabled="
                      chat.enabled ||
                      !session.sensitiveActive ||
                      chatDeleteBusyIds.has(chat.id)
                    "
                    :aria-busy="chatDeleteBusyIds.has(chat.id)"
                    :title="
                      chat.enabled
                        ? '请先停用监听后再删除'
                        : '删除该聊天（历史记录仍会保留）'
                    "
                    @click="deleteChat(chat)"
                  >
                    <Trash2 :size="14" />
                    {{ chatDeleteBusyIds.has(chat.id) ? "删除中…" : "删除" }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <article v-if="participantChat" class="participant-editor">
          <header>
            <div>
              <p class="card-kicker">PARTICIPANT IDENTITIES</p>
              <h3>
                {{
                  participantChat.displayName || participantChat.providerChatId
                }}
                · 成员映射
              </h3>
              <p>
                只列出该聊天历史中实际出现过的发送者
                ID。留空本名和昵称后保存即可删除对应映射。
              </p>
            </div>
            <button
              class="icon-button"
              type="button"
              :disabled="participantSaveBusy"
              aria-label="关闭成员映射编辑器"
              @click="closeParticipantEditor"
            >
              <X :size="16" />
            </button>
          </header>
          <div v-if="participantBusy" class="empty-panel">
            <Users :size="28" /><strong>正在读取历史成员…</strong>
          </div>
          <div v-else-if="participantDrafts.length === 0" class="empty-panel">
            <Users :size="28" /><strong>尚未发现可配置的成员</strong
            ><span>收到并归档非本人消息后，发送者 ID 会出现在这里。</span>
          </div>
          <div v-else class="table-shell participant-table">
            <table>
              <thead>
                <tr>
                  <th>发送者 ID</th>
                  <th>历史记录</th>
                  <th>本名</th>
                  <th>昵称</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="participant in participantDrafts"
                  :key="participant.senderId"
                >
                  <td>
                    <strong class="mono">{{ participant.senderId }}</strong>
                    <span class="keyline">
                      最后出现：{{
                        new Date(participant.lastSeenAt).toLocaleString()
                      }}
                    </span>
                  </td>
                  <td>{{ participant.messageCount }} 条</td>
                  <td>
                    <input
                      v-model="participant.realName"
                      type="text"
                      maxlength="120"
                      autocomplete="off"
                      placeholder="例如：刘某"
                    />
                  </td>
                  <td>
                    <input
                      v-model="participant.nickname"
                      type="text"
                      maxlength="120"
                      autocomplete="off"
                      placeholder="例如：老大"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="form-actions">
            <button
              class="button primary"
              type="button"
              :disabled="
                !session.sensitiveActive ||
                participantBusy ||
                participantSaveBusy
              "
              :aria-busy="participantSaveBusy"
              @click="saveParticipants"
            >
              <Save :size="16" />{{
                participantSaveBusy ? "保存中…" : "保存成员映射"
              }}
            </button>
          </div>
        </article>
        <CursorPagination
          :page="chatPager.pageNumber.value"
          :item-count="chats.length"
          :busy="chatPager.busy.value"
          :has-previous="chatPager.hasPrevious.value"
          :has-next="chatPager.hasNext.value"
          @previous="changePage(chatPager.previous)"
          @next="changePage(chatPager.next)"
        />
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
                v-for="chat in chatOptions"
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
            <div
              v-if="item.linkPreview.status !== 'not-requested'"
              class="message-link-preview"
            >
              <header>
                <strong>链接卡片</strong>
                <span>{{ item.linkPreview.status }}</span>
              </header>
              <article
                v-for="preview in item.linkPreview.items"
                :key="preview.url"
              >
                <a
                  :href="preview.url"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {{ preview.title || preview.siteName || preview.url }}
                </a>
                <p v-if="preview.summary">{{ preview.summary }}</p>
                <small>
                  {{ preview.source }} · 图片{{
                    preview.imageAvailable ? "可用" : "无"
                  }}
                  · 图标{{ preview.iconAvailable ? "可用" : "无" }}
                </small>
              </article>
              <details v-if="item.linkPreviewDiagnostics.length">
                <summary>解析诊断</summary>
                <p
                  v-for="diagnostic in item.linkPreviewDiagnostics"
                  :key="`${diagnostic.source}-${diagnostic.attempt}`"
                >
                  {{ diagnostic.source }} #{{ diagnostic.attempt }} ·
                  {{ diagnostic.status }} · {{ diagnostic.durationMs }} ms
                  <span v-if="diagnostic.code"> · {{ diagnostic.code }}</span>
                </p>
              </details>
            </div>
            <footer>
              <span>{{
                item.isFromMe ? "我发送" : item.senderId || "未知发送者"
              }}</span>
              <div class="message-footer-actions">
                <button
                  v-if="hasImageMedia(item)"
                  class="button tiny secondary"
                  type="button"
                  @click="openMessageMedia(item)"
                >
                  <Images :size="14" />图片与 AI 摘要
                </button>
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
              </div>
            </footer>
          </article>
          <div v-if="!messages.length" class="empty-panel">
            <MessageCircle :size="28" /><strong>没有搜索结果</strong
            ><span>调整聊天、关键词、发送者或时间范围后重试。</span>
          </div>
        </div>
        <CursorPagination
          v-if="session.sensitiveActive"
          :page="messagePager.pageNumber.value"
          :item-count="messages.length"
          :busy="messagePager.busy.value"
          :has-previous="messagePager.hasPrevious.value"
          :has-next="messagePager.hasNext.value"
          @previous="changePage(messagePager.previous)"
          @next="changePage(messagePager.next)"
        />
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
                v-for="chat in chatOptions"
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
        <CursorPagination
          :page="exportPager.pageNumber.value"
          :item-count="exportJobs.length"
          :busy="exportPager.busy.value"
          :has-previous="exportPager.hasPrevious.value"
          :has-next="exportPager.hasNext.value"
          @previous="changePage(exportPager.previous)"
          @next="changePage(exportPager.next)"
        />
      </section>
    </div>
  </main>
  <Teleport to="body">
    <div
      v-if="mediaMessage"
      class="message-media-backdrop"
      @click.self="closeMessageMedia"
      @keyup.esc="closeMessageMedia"
    >
      <section
        class="message-media-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-media-title"
      >
        <header class="message-media-dialog-head">
          <div>
            <p class="card-kicker">IMAGE ARCHIVE</p>
            <h2 id="message-media-title">图片与 AI 摘要</h2>
            <span>
              {{ mediaMessage.chatDisplayName || mediaMessage.providerChatId }}
              · {{ new Date(mediaMessage.sentAt).toLocaleString() }}
            </span>
          </div>
          <div class="message-media-dialog-actions">
            <button
              class="icon-button"
              type="button"
              :disabled="mediaBusy"
              title="刷新摘要状态"
              aria-label="刷新摘要状态"
              @click="loadMessageMedia"
            >
              <RefreshCw :size="17" :class="{ 'button-spinner': mediaBusy }" />
            </button>
            <button
              class="icon-button"
              type="button"
              title="关闭"
              aria-label="关闭图片详情"
              @click="closeMessageMedia"
            >
              <X :size="18" />
            </button>
          </div>
        </header>
        <div class="message-media-dialog-body">
          <div v-if="mediaError" class="message-media-alert">
            {{ mediaError }}
          </div>
          <div v-if="mediaBusy && !mediaDetail" class="empty-panel compact">
            <RefreshCw :size="22" class="button-spinner" />
            <strong>正在读取图片状态</strong>
          </div>
          <div
            v-else-if="mediaDetail && !mediaDetail.items.length"
            class="empty-panel compact"
          >
            <Images :size="24" />
            <strong>没有可查看的图片</strong>
            <span>图片可能已经按消息保留策略清理。</span>
          </div>
          <div v-else-if="mediaDetail" class="message-media-grid">
            <article
              v-for="item in mediaDetail.items"
              :key="item.attachmentRef"
              class="message-media-item"
            >
              <div class="message-media-preview">
                <img
                  v-if="!failedMediaPreviews.has(item.attachmentRef)"
                  :src="item.previewUrl"
                  :alt="item.label"
                  @error="failedMediaPreviews.add(item.attachmentRef)"
                />
                <div v-else>
                  <Images :size="28" />
                  <span>原图预览不可用</span>
                </div>
              </div>
              <div class="message-media-copy">
                <header>
                  <div>
                    <span>{{ item.sourceType }}</span>
                    <h3>{{ item.fileName || item.label }}</h3>
                  </div>
                  <span class="summary-state" :class="item.summaryStatus">{{
                    imageSummaryStatusLabel(item.summaryStatus)
                  }}</span>
                </header>
                <p class="message-media-meta">
                  {{ item.declaredMimeType || "图片类型未知" }} ·
                  {{ formatMediaBytes(item.sizeBytes) }}
                </p>
                <div v-if="item.summary" class="message-media-summary">
                  <span>AI 摘要</span>
                  <p>{{ item.summary }}</p>
                </div>
                <p v-else class="message-media-status-copy">
                  {{ imageSummaryStatusDescription(item.summaryStatus) }}
                </p>
                <dl class="message-media-diagnostics">
                  <div>
                    <dt>Provider</dt>
                    <dd>{{ item.providerName || "—" }}</dd>
                  </div>
                  <div>
                    <dt>模型</dt>
                    <dd>{{ item.model || "—" }}</dd>
                  </div>
                  <div>
                    <dt>耗时</dt>
                    <dd>
                      {{
                        item.durationMs === null ? "—" : `${item.durationMs} ms`
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>尝试</dt>
                    <dd>{{ item.attemptCount || "—" }}</dd>
                  </div>
                </dl>
                <code v-if="item.errorCode" class="message-media-error">{{
                  item.errorCode
                }}</code>
              </div>
            </article>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>
