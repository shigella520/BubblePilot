<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { apiRequest, errorMessage } from "../../services/api";
import { idleTaskInstruction } from "../../../../../modules/workflow/idle-defaults";
import type { IdleTriggerConfig } from "../../../../../modules/workflow/idle-policy";
const props = defineProps<{
  modelValue?: IdleTriggerConfig;
  chats: Array<{ value: string; label: string }>;
}>();
const chatChoices = computed(() => [
  ...props.chats,
  ...(props.modelValue?.chatIds ?? [])
    .filter((id) => !props.chats.some((chat) => chat.value === id))
    .map((id) => ({ value: id, label: `${id}（不可用，可取消选择）` })),
]);
const emit = defineEmits<{
  (event: "update:modelValue", value: IdleTriggerConfig): void;
}>();
const settings = ref<{
  timeZone: string;
} | null>(null);
const error = ref("");
const days = ["一", "二", "三", "四", "五", "六", "日"];
onMounted(async () => {
  try {
    settings.value = await apiRequest("/api/v1/settings/idle");
  } catch (cause) {
    error.value = errorMessage(cause);
  }
});
function update(change: Partial<IdleTriggerConfig>) {
  const value = props.modelValue ?? {
    enabled: false,
    chatIds: [],
    idleMinutes: 60,
    timeZone: settings.value?.timeZone ?? "Asia/Shanghai",
    dailyLimit: 2,
    taskInstruction: idleTaskInstruction,
    quietPeriods: [
      { days: [1, 2, 3, 4, 5, 6, 7], start: "23:00", end: "09:00" },
    ],
  };
  emit("update:modelValue", { ...value, ...change });
}
function selectChat(id: string, enabled: boolean) {
  const ids = props.modelValue?.chatIds ?? [];
  update({
    chatIds: enabled
      ? [...new Set([...ids, id])]
      : ids.filter((value) => value !== id),
  });
}
function period(
  index: number,
  change: Partial<IdleTriggerConfig["quietPeriods"][number]>,
) {
  update({
    quietPeriods: (props.modelValue?.quietPeriods ?? []).map((value, i) =>
      i === index ? { ...value, ...change } : value,
    ),
  });
}
</script>
<template>
  <section class="idle-settings">
    <h4>空闲主动交流</h4>
    <p>沿用本工作流的角色。只向选中的聊天主动发言；无人回应不连续发言。</p>
    <label
      ><input
        type="checkbox"
        :checked="modelValue?.enabled ?? false"
        :disabled="!settings"
        @change="
          update({ enabled: ($event.target as HTMLInputElement).checked })
        "
      />启用空闲主动交流</label
    >
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="modelValue?.enabled">
      <fieldset>
        <legend>允许主动发言的聊天（必须选择）</legend>
        <label v-for="chat in chatChoices" :key="chat.value"
          ><input
            type="checkbox"
            :checked="modelValue.chatIds.includes(chat.value)"
            @change="
              selectChat(
                chat.value,
                ($event.target as HTMLInputElement).checked,
              )
            "
          />{{ chat.label }}</label
        >
        <p v-if="!chats.length">没有可选聊天，请先开启聊天归档。</p>
        <p v-if="!modelValue.chatIds.length">尚未选择聊天，不能启用。</p>
      </fieldset>
      <label
        >空闲时长（2～360 分钟）<input
          type="number"
          min="2"
          max="360"
          :value="modelValue.idleMinutes"
          @input="
            update({
              idleMinutes: Number(($event.target as HTMLInputElement).value),
            })
          "
      /></label>
      <label
        >时区<input
          :value="modelValue.timeZone"
          @change="
            update({ timeZone: ($event.target as HTMLInputElement).value })
          "
      /></label>
      <label
        >本工作流每聊天每日上限（2～666 次）<input
          type="number"
          min="2"
          max="666"
          :value="modelValue.dailyLimit"
          @input="
            update({
              dailyLimit: Number(($event.target as HTMLInputElement).value),
            })
          "
      /></label>
      <fieldset v-for="(window, index) in modelValue.quietPeriods" :key="index">
        <legend>免打扰 {{ index + 1 }}</legend>
        <div class="idle-days">
          <label v-for="(day, i) in days" :key="day"
            ><input
              type="checkbox"
              :checked="window.days.includes(i + 1)"
              @change="
                period(index, {
                  days: ($event.target as HTMLInputElement).checked
                    ? [...window.days, i + 1]
                    : window.days.filter((d) => d !== i + 1),
                })
              "
            />{{ day }}</label
          >
        </div>
        <label
          >开始<input
            type="time"
            :value="window.start"
            @change="
              period(index, {
                start: ($event.target as HTMLInputElement).value,
              })
            "
        /></label>
        <label
          >结束<input
            type="time"
            :value="window.end"
            @change="
              period(index, { end: ($event.target as HTMLInputElement).value })
            "
        /></label>
        <button
          type="button"
          @click="
            update({
              quietPeriods: modelValue.quietPeriods.filter(
                (_, i) => i !== index,
              ),
            })
          "
        >
          删除时段
        </button>
      </fieldset>
      <button
        type="button"
        :disabled="modelValue.quietPeriods.length >= 20"
        @click="
          update({
            quietPeriods: [
              ...modelValue.quietPeriods,
              { days: [1, 2, 3, 4, 5, 6, 7], start: '23:00', end: '09:00' },
            ],
          })
        "
      >
        添加免打扰时段
      </button>
      <small
        >跨午夜时，星期代表开始日。解除免打扰后重新等待完整空闲时长。</small
      >
      <label
        >主动交流提示词<textarea
          rows="5"
          :value="modelValue.taskInstruction"
          @input="
            update({
              taskInstruction: ($event.target as HTMLTextAreaElement).value,
            })
          "
        />
      </label>
      <small
        >只填写交流要求，无需填写 JSON
        或发送／跳过协议。保存并发布后生效。</small
      >
      <button
        type="button"
        class="button secondary"
        @click="update({ taskInstruction: idleTaskInstruction })"
      >
        恢复默认
      </button>
    </template>
  </section>
</template>
<style scoped>
.idle-settings {
  display: grid;
  gap: 12px;
  padding: 16px 0;
  border-top: 1px solid var(--border-color, #ddd);
}
.idle-settings label {
  display: grid;
  gap: 6px;
}
.idle-settings fieldset {
  min-width: 0;
  display: grid;
  gap: 8px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 8px;
}
.idle-settings fieldset label:has(input[type="checkbox"]),
.idle-settings > label:first-of-type {
  display: flex;
  align-items: center;
  gap: 8px;
}
.idle-days {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.idle-settings input:not([type="checkbox"]),
.idle-settings textarea {
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
}
.idle-settings p,
.idle-settings small {
  margin: 0;
  line-height: 1.5;
}
</style>
