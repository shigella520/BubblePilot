<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { apiRequest, errorMessage, jsonBody } from "../../services/api";
import { serializeTriggerConfig } from "../../utils/workflow-trigger-config";

const props = defineProps<{ config: Record<string, unknown> }>();
type CheckField =
  "chat" | "sender" | "contentType" | "text" | "timeWindow" | "isFromMe";
type Preview = {
  matched: boolean;
  matchSource?: "ordinary" | "reply" | null;
  checks: Array<{ field: CheckField; matched: boolean }>;
};
const labels: Record<CheckField, string> = {
  chat: "聊天范围",
  sender: "发送者范围",
  contentType: "消息类型",
  text: "消息匹配内容",
  timeWindow: "时间范围",
  isFromMe: "本人消息",
};
const sample = reactive({
  providerChatId: "iMessage;-;fictional-preview-chat",
  senderId: "fictional-member@example.test",
  contentType: "text",
  text: "请继续解释",
  replyTarget: "same-workflow",
  isFromMe: false,
});
const result = ref<Preview | null>(null);
const error = ref("");
const busy = ref(false);
let requestId = 0;
watch(
  () => [JSON.stringify(props.config), JSON.stringify(sample)],
  () => {
    requestId++;
    result.value = null;
    error.value = "";
  },
);

async function preview() {
  const current = ++requestId;
  const config = serializeTriggerConfig(props.config);
  busy.value = true;
  result.value = null;
  error.value = "";
  try {
    const data = await apiRequest<Preview>("/api/v1/triggers/preview", {
      method: "POST",
      body: jsonBody({
        conditions: {
          chatIds: config.chatIds,
          senderIds: config.senderIds,
          contentTypes: config.contentTypes,
          text: config.text,
          timeWindow: null,
        },
        includeFromMe: config.includeFromMe,
        sample: {
          ...sample,
          senderId: sample.senderId || null,
          text: sample.text || null,
        },
      }),
    });
    if (current === requestId) result.value = data;
  } catch (cause) {
    if (current === requestId) error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <details class="trigger-sample">
    <summary>模拟消息匹配</summary>
    <p>
      使用样本检查当前条件，不查询聊天、不调用模型或发送消息；不检查工作流启用状态。
    </p>
    <label>样本聊天 ID<input v-model.trim="sample.providerChatId" /></label>
    <label>样本发送者 ID<input v-model.trim="sample.senderId" /></label>
    <label
      >消息类型<select v-model="sample.contentType">
        <option value="text">文本</option>
        <option value="attachment">附件</option>
        <option value="mixed">混合</option>
        <option value="unknown">未知</option>
      </select></label
    >
    <label>样本文本<input v-model="sample.text" /></label>
    <label
      >引用对象<select v-model="sample.replyTarget">
        <option value="same-workflow">本工作流的 Bot</option>
        <option value="other-workflow">其他工作流的 Bot</option>
        <option value="participant">普通成员</option>
        <option value="unknown">无法确认</option>
        <option value="none">无引用</option>
      </select></label
    >
    <label class="sample-checkbox"
      ><input v-model="sample.isFromMe" type="checkbox" />网关本人发送</label
    >
    <button
      class="button secondary"
      type="button"
      :disabled="busy || !sample.providerChatId"
      @click="preview"
    >
      {{ busy ? "检查中…" : "检查样本" }}
    </button>
    <p v-if="error" role="alert">{{ error }}</p>
    <div v-if="result" class="sample-result" aria-live="polite">
      <strong>{{ result.matched ? "匹配" : "不匹配" }}</strong>
      <span v-if="result.matchSource">{{
        result.matchSource === "reply" ? "回复 Bot 消息" : "原条件匹配"
      }}</span>
      <span v-for="check in result.checks" :key="check.field">
        {{ labels[check.field] }}：{{
          check.matched
            ? "通过"
            : check.field === "text" && result.matchSource === "reply"
              ? "未匹配，引用已放行"
              : "未通过"
        }}
      </span>
    </div>
  </details>
</template>

<style scoped>
.trigger-sample {
  margin: 16px 0;
  padding: 12px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 10px;
}
.trigger-sample summary {
  cursor: pointer;
  font-weight: 600;
}
.trigger-sample p {
  font-size: 13px;
  color: var(--text-secondary, #666);
}
.trigger-sample label {
  display: grid;
  gap: 4px;
  margin: 10px 0;
}
.trigger-sample input:not([type="checkbox"]),
.trigger-sample select {
  width: 100%;
  min-width: 0;
}
.trigger-sample .sample-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sample-checkbox input {
  width: auto;
}
.sample-result {
  display: grid;
  gap: 4px;
  margin-top: 12px;
  font-size: 13px;
  overflow-wrap: anywhere;
}
</style>
