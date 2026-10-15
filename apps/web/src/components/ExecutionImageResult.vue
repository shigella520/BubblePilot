<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import AdminDetailDialog from "./AdminDetailDialog.vue";
import { apiRequest, errorMessage } from "../services/api";
import { useSessionStore } from "../stores/session";
const props = defineProps<{
  executionId: string;
  imageId: string;
  diagnostic?: {
    imageRef: string;
    messageId: string;
    trigger: string;
    toolCallId: string | null;
    round: number;
    width: number | null;
    height: number | null;
    contentHash: string;
  } | null;
  attempts: {
    id: string;
    status: string;
    providerName: string;
    model: string;
    diagnostics: {
      imageInputs?: {
        dispatched: boolean;
        images: { imageInputId: string; contentHash: string }[];
      } | null;
    } | null;
  }[];
}>();
const session = useSessionStore();
const url = ref("");
const busy = ref(false);
const error = ref("");
const expanded = ref(false);
const sourceText = ref("");
let sourceEpoch = 0;
async function showSource() {
  if (!session.sensitiveActive || busy.value) return;
  const epoch = ++sourceEpoch;
  busy.value = true;
  error.value = "";
  try {
    const result = await apiRequest<{
      sentAt: string;
      senderId: string | null;
      body: string | null;
    }>(
      `/api/v1/executions/${props.executionId}/image-inputs/${props.imageId}/source`,
    );
    if (epoch === sourceEpoch && session.sensitiveActive)
      sourceText.value = `${result.sentAt} ${result.senderId ?? ""}\n${result.body ?? "（无文字正文）"}`;
  } catch (cause) {
    if (epoch === sourceEpoch) error.value = errorMessage(cause);
  } finally {
    if (epoch === sourceEpoch) busy.value = false;
  }
}
let controller: AbortController | null = null;
function clear() {
  sourceEpoch++;
  sourceText.value = "";
  controller?.abort();
  controller = null;
  if (url.value) URL.revokeObjectURL(url.value);
  url.value = "";
  expanded.value = false;
  busy.value = false;
  error.value = "";
}
async function preview() {
  if (!session.sensitiveActive || busy.value) return;
  busy.value = true;
  error.value = "";
  const operation = new AbortController();
  controller = operation;
  try {
    const result = await fetch(
      `/api/v1/executions/${props.executionId}/image-inputs/${props.imageId}/preview`,
      {
        credentials: "same-origin",
        cache: "no-store",
        signal: operation.signal,
      },
    );
    if (!result.ok)
      throw new Error(
        result.status === 403 || result.status === 401
          ? "请重新解锁敏感操作。"
          : "无法还原当时图片：来源已清理、权限失效或内容哈希发生变化。",
      );
    const blob = await result.blob();
    if (controller !== operation || !session.sensitiveActive) return;
    if (url.value) URL.revokeObjectURL(url.value);
    url.value = URL.createObjectURL(blob);
  } catch (cause) {
    if (controller === operation)
      error.value =
        cause instanceof Error ? cause.message : "加载失败，请重试。";
  } finally {
    if (controller === operation) busy.value = false;
  }
}
watch(
  () => session.sensitiveActive,
  (active) => {
    if (!active) clear();
  },
);
watch(() => props.imageId, clear);
onBeforeUnmount(clear);
function requests() {
  return props.attempts.filter((a) =>
    a.diagnostics?.imageInputs?.images.some(
      (i) => i.imageInputId === props.imageId,
    ),
  );
}
</script>
<template>
  <div v-if="diagnostic" class="image-result">
    <p>
      {{ diagnostic.trigger === "tool" ? "工具追加" : "自动带入" }} · 第
      {{ diagnostic.round }} 轮 · {{ diagnostic.width ?? "—" }} ×
      {{ diagnostic.height ?? "—" }}
    </p>
    <p v-if="!requests().length">加载成功，尚未记录携图请求。</p>
    <p v-for="attempt in requests()" :key="attempt.id">
      {{ attempt.providerName }} / {{ attempt.model }} ·
      {{
        attempt.diagnostics?.imageInputs?.dispatched
          ? attempt.status === "succeeded"
            ? "携图请求成功"
            : "携图请求失败"
          : "未发起携图请求"
      }}
    </p>
    <p>请求发起不代表对端已接收或模型已理解。使用 BlueBubbles 兼容图片版本。</p>
    <code
      >{{ diagnostic.imageRef }} ·
      {{ diagnostic.toolCallId ?? "自动输入" }}</code
    >
    <p>
      <button
        class="button secondary"
        :disabled="!session.sensitiveActive || busy"
        @click="preview"
      >
        {{ busy ? "加载图片中…" : "查看受保护图片" }}
      </button>
    </p>
    <button
      v-if="url && session.sensitiveActive"
      class="thumbnail"
      @click="expanded = true"
    >
      <img :src="url" alt="本次执行使用的聊天图片，点击放大" />
    </button>
    <p>
      <button
        class="button secondary"
        :disabled="!session.sensitiveActive || busy"
        @click="showSource"
      >
        查看来源消息
      </button>
    </p>
    <AdminDetailDialog
      v-if="sourceText && session.sensitiveActive"
      title="图片来源原文"
      @close="sourceText = ''"
    >
      <pre style="white-space: pre-wrap; overflow-wrap: anywhere">{{
        sourceText
      }}</pre>
    </AdminDetailDialog>
    <p v-if="!session.sensitiveActive">解锁敏感操作后可查看图片。</p>
    <p v-if="error" role="status">{{ error }}</p>
    <AdminDetailDialog
      v-if="expanded && url && session.sensitiveActive"
      title="执行图片 · 兼容版本"
      @close="expanded = false"
      ><img class="full-image" :src="url" alt="执行图片详情"
    /></AdminDetailDialog>
  </div>
  <p v-else>未记录图片关联信息</p>
</template>
<style scoped>
.image-result {
  overflow-wrap: anywhere;
}
.thumbnail {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
}
.thumbnail img {
  width: 160px;
  height: 120px;
  object-fit: contain;
  border-radius: 10px;
}
.full-image {
  display: block;
  max-width: 100%;
  max-height: 75vh;
  object-fit: contain;
}
</style>
