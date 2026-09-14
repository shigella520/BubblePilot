<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { apiRequest, errorMessage, jsonBody } from "../services/api";
import DismissibleMessage from "./DismissibleMessage.vue";
interface Settings {
  maxToolCalls: number;
  maxToolOutputCharacters: number;
  maxToolDurationMs: number;
  source: "defaults" | "database";
  version: number;
  updatedAt: string | null;
}
const defaults = {
  maxToolCalls: 10,
  maxToolOutputCharacters: 24000,
  seconds: 60,
};
const form = reactive({ ...defaults });
const settings = ref<Settings | null>(null);
const busy = ref(false);
const error = ref("");
const message = ref("");
function apply(value: Settings) {
  settings.value = value;
  Object.assign(form, {
    maxToolCalls: value.maxToolCalls,
    maxToolOutputCharacters: value.maxToolOutputCharacters,
    seconds: value.maxToolDurationMs / 1000,
  });
}
async function load() {
  message.value = "";
  busy.value = true;
  error.value = "";
  try {
    apply(await apiRequest<Settings>("/api/v1/ai/agent/settings"));
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function save() {
  if (!settings.value || busy.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    apply(
      await apiRequest<Settings>("/api/v1/ai/agent/settings", {
        method: "PUT",
        body: jsonBody({
          maxToolCalls: form.maxToolCalls,
          maxToolOutputCharacters: form.maxToolOutputCharacters,
          maxToolDurationMs: form.seconds * 1000,
          expectedVersion: settings.value.version,
        }),
      }),
    );
    message.value = "已保存，对后续 Agent 运行生效。";
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
function restore() {
  Object.assign(form, defaults);
  message.value = "已恢复默认值，保存后生效。";
}
onMounted(load);
</script>
<template>
  <section id="agent-settings" class="admin-panel">
    <h2>Agent 执行配置</h2>
    <p class="muted">
      全部应用侧工具共用单次 Agent
      运行预算，不是每日额度。证据足够时模型可以提前回答，无须用满预算。增加预算可能增加等待时间和模型用量，不保证答案一定正确。
    </p>
    <DismissibleMessage v-if="error" error inline @close="error = ''">{{
      error
    }}</DismissibleMessage>
    <DismissibleMessage v-if="message" inline @close="message = ''">{{
      message
    }}</DismissibleMessage>
    <p v-if="settings" class="muted">
      配置来源：{{ settings.source === "database" ? "已保存配置" : "默认值" }} ·
      版本 {{ settings.version }} · 更新时间：{{
        settings.updatedAt
          ? new Date(settings.updatedAt).toLocaleString()
          : "尚未保存"
      }}
    </p>
    <form @submit.prevent="save">
      <fieldset :disabled="busy || !settings" class="agent-fields">
        <label
          >工具调用总次数<input
            v-model.number="form.maxToolCalls"
            type="number"
            min="1"
            max="30"
            step="1"
            required
          /><span class="muted"
            >1～30 次，联网、历史查询与原文展开共享。</span
          ></label
        >
        <label
          >工具返回内容总预算<input
            v-model.number="form.maxToolOutputCharacters"
            type="number"
            min="4000"
            max="100000"
            step="1"
            required
          /><span class="muted"
            >4,000～100,000 字符，包含来源元数据。</span
          ></label
        >
        <label
          >工具执行累计时长（秒）<input
            v-model.number="form.seconds"
            type="number"
            min="5"
            max="180"
            step="0.001"
            required
          /><span class="muted"
            >包括工具内部重试，不含模型思考和生成时间。</span
          ></label
        >
        <p class="muted">
          模型轮数按调用次数自动推导，并为最终回答及现有引用修正预留机会。每个
          Agent 节点分别计额；修改不影响进行中的运行。
        </p>
        <div class="agent-actions">
          <button type="submit" class="button primary">
            {{ busy ? "处理中…" : "保存" }}</button
          ><button class="button secondary" type="button" @click="restore">
            恢复默认值
          </button>
        </div>
      </fieldset>
    </form>
    <button
      class="button secondary"
      type="button"
      :disabled="busy"
      @click="load"
    >
      重新加载已保存配置
    </button>
  </section>
</template>
<style scoped>
.muted {
  color: var(--bubblepilot-muted);
}
.agent-fields {
  border: 0;
  padding: 0;
  display: grid;
  gap: 16px;
}
.agent-fields label {
  display: grid;
  gap: 8px;
}
.agent-actions {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
</style>
