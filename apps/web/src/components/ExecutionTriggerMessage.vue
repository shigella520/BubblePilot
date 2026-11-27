<script setup lang="ts">
import { formatDateTime } from "../utils/format";
import {
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  MessageSquare,
} from "@lucide/vue";
import { onBeforeUnmount, ref, watch } from "vue";
import SensitiveUnlock from "./SensitiveUnlock.vue";
import { apiRequest, errorMessage } from "../services/api";
import { useSessionStore } from "../stores/session";

const props = defineProps<{
  executionId: string;
  sourceMessageId?: string | null;
  scheduled: boolean;
  chatName: string;
}>();
interface SourceMessage {
  messageId: string;
  sentAt: string;
  senderId: string | null;
  body: string | null;
  retractedBody: string | null;
  revisionState: string;
  editedAt: string | null;
  attachments: {
    fileName: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
  }[];
}
const session = useSessionStore();
const message = ref<SourceMessage | null>(null);
const busy = ref(false);
const error = ref("");
const unlocking = ref(false);
let operation: AbortController | null = null;
function conceal() {
  operation?.abort();
  operation = null;
  message.value = null;
  busy.value = false;
  error.value = "";
}
async function reveal() {
  if (!session.sensitiveActive || busy.value) return;
  if (message.value) {
    conceal();
    return;
  }
  const current = new AbortController();
  operation = current;
  busy.value = true;
  error.value = "";
  try {
    const result = await apiRequest<SourceMessage>(
      `/api/v1/executions/${props.executionId}/source-message`,
      { signal: current.signal, cache: "no-store" },
    );
    if (operation === current && session.sensitiveActive)
      message.value = result;
  } catch (cause) {
    if (operation === current) error.value = errorMessage(cause);
  } finally {
    if (operation === current) busy.value = false;
  }
}
watch(
  () => session.sensitiveActive,
  (active) => {
    if (!active) conceal();
    else unlocking.value = false;
  },
);
watch(
  () => props.executionId,
  () => {
    conceal();
    unlocking.value = false;
  },
);
onBeforeUnmount(conceal);
</script>

<template>
  <section
    class="execution-source-card"
    aria-labelledby="execution-source-title"
  >
    <div class="source-heading">
      <div class="source-label">
        <h3 id="execution-source-title">
          <MessageSquare :size="17" />触发消息
        </h3>
        <p>{{ chatName }}</p>
      </div>
      <div v-if="!scheduled && sourceMessageId" class="source-actions">
        <button
          v-if="!session.sensitiveActive"
          class="button secondary"
          type="button"
          :aria-expanded="unlocking"
          @click="unlocking = !unlocking"
        >
          <KeyRound :size="15" />解锁查看
        </button>
        <button
          class="icon-button"
          type="button"
          :disabled="!session.sensitiveActive || busy"
          :aria-label="message ? '隐藏触发消息' : '查看触发消息'"
          :title="
            !session.sensitiveActive
              ? '需要敏感操作授权'
              : message
                ? '隐藏触发消息'
                : '查看触发消息'
          "
          :aria-pressed="Boolean(message)"
          @click="reveal"
        >
          <LoaderCircle v-if="busy" :size="18" class="spin" />
          <EyeOff v-else-if="message" :size="18" />
          <Eye v-else :size="18" />
        </button>
      </div>
    </div>
    <p v-if="scheduled" class="source-note">
      调度触发（主动交流 / 定时任务），没有入站触发消息。
    </p>
    <p v-else-if="!sourceMessageId" class="source-note">
      未关联触发消息，或归档记录已删除。
    </p>
    <template v-else>
      <SensitiveUnlock v-if="unlocking && !session.sensitiveActive" />
      <div v-if="message && session.sensitiveActive" class="source-content">
        <div class="source-metadata">
          <span>{{ formatDateTime(message.sentAt) }}</span>
          <span>发送者：{{ message.senderId ?? "未知" }}</span>
          <span v-if="message.editedAt" class="status-badge">已编辑</span>
          <span
            v-if="message.revisionState === 'retracted'"
            class="status-badge"
            >已撤回</span
          >
          <span v-if="message.revisionState === 'partial'" class="status-badge"
            >部分撤回</span
          >
          <span
            v-if="message.revisionState === 'unresolved'"
            class="status-badge"
            >修订状态待确认</span
          >
        </div>
        <pre class="source-body">{{ message.body || "（无文字正文）" }}</pre>
        <details v-if="message.retractedBody">
          <summary>已撤回的留存正文</summary>
          <pre class="source-body">{{ message.retractedBody }}</pre>
        </details>
        <ul
          v-if="message.attachments.length"
          class="source-attachments"
          aria-label="消息附件"
        >
          <li v-for="(attachment, index) in message.attachments" :key="index">
            {{ attachment.fileName ?? "未命名附件" }} ·
            {{ attachment.mimeType ?? "未知类型" }}
          </li>
        </ul>
        <p class="source-note">
          当前归档版本；编辑、撤回或清理后，可能与执行触发时不同。附件仅展示信息，不自动下载。
        </p>
      </div>
      <div v-else class="source-placeholder" :aria-busy="busy">
        <span aria-hidden="true">••••••••••••••••</span>
        <p>
          {{
            busy
              ? "正在读取触发消息…"
              : session.sensitiveActive
                ? "已验证，点击小眼睛查看原文。"
                : "内容已隐藏，完成敏感操作授权后点击小眼睛查看。"
          }}
        </p>
      </div>
      <p v-if="error" class="form-message error" role="alert">{{ error }}</p>
    </template>
  </section>
</template>

<style scoped>
.execution-source-card {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--bubblepilot-line);
  border-radius: 16px;
  background: rgba(247, 250, 255, 0.62);
  overflow-wrap: anywhere;
}
.source-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.source-label {
  min-width: 0;
  flex: 1 1 180px;
}
.source-label h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 15px;
}
.source-label h3 svg {
  flex-shrink: 0;
}
.source-label p,
.source-note {
  margin: 8px 0 0;
  color: var(--bubblepilot-muted);
  font-size: 12px;
  line-height: 1.6;
}
.source-actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 8px;
}
.source-actions .icon-button {
  width: 36px;
  height: 36px;
  border: 1px solid var(--bubblepilot-line);
  border-radius: 10px;
}
.source-placeholder {
  margin-top: 12px;
  padding: 12px;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.04);
}
.source-placeholder > span {
  letter-spacing: 3px;
  color: var(--bubblepilot-muted);
}
.source-placeholder p {
  margin: 6px 0 0;
  color: var(--bubblepilot-muted);
  font-size: 12px;
}
.source-content {
  margin-top: 14px;
}
.source-metadata {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  font-size: 12px;
}
.source-body {
  max-height: 300px;
  max-height: min(300px, 40dvh);
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.7;
  padding: 12px;
  background: white;
  border: 1px solid var(--bubblepilot-line);
  border-radius: 10px;
}
.source-attachments {
  padding-left: 20px;
  max-height: 160px;
  overflow: auto;
  font-size: 13px;
}
</style>
