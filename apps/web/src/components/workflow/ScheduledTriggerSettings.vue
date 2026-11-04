<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { apiRequest } from "../../services/api";
interface Config {
  enabled: boolean;
  chatIds: string[];
  timeZone: string;
  memberPendingLimit: number;
}
const props = defineProps<{
  modelValue?: Config;
  chats: Array<{ value: string; label: string }>;
}>();
const emit = defineEmits<{
  (event: "update:modelValue", value: Config): void;
}>();
const zone = ref("Asia/Shanghai");
onMounted(async () => {
  try {
    zone.value = (
      await apiRequest<{ timeZone: string }>("/api/v1/settings/idle")
    ).timeZone;
  } catch {
    /* Explicit editable default remains visible. */
  }
});
const chats = computed(() => [
  ...props.chats,
  ...(props.modelValue?.chatIds ?? [])
    .filter((id) => !props.chats.some((c) => c.value === id))
    .map((id) => ({ value: id, label: `${id}（不可用）` })),
]);
function update(change: Partial<Config>) {
  emit("update:modelValue", {
    enabled: false,
    chatIds: [],
    timeZone: zone.value,
    memberPendingLimit: 20,
    ...props.modelValue,
    ...change,
  });
}
function select(id: string, checked: boolean) {
  const ids = props.modelValue?.chatIds ?? [];
  update({
    chatIds: checked ? [...new Set([...ids, id])] : ids.filter((v) => v !== id),
  });
}
</script>
<template>
  <section class="scheduled-settings">
    <h4>聊天定时提醒</h4>
    <p>
      用户可在选定聊天委托本角色登记单次提醒。到点重新生成提醒，失败时使用固定文字。夜间提醒不受空闲交流免打扰限制。
    </p>
    <label
      ><input
        type="checkbox"
        :checked="modelValue?.enabled ?? false"
        @change="
          update({ enabled: ($event.target as HTMLInputElement).checked })
        "
      />允许创建定时提醒</label
    >
    <template v-if="modelValue?.enabled">
      <fieldset>
        <legend>允许提醒的聊天（必须选择）</legend>
        <label v-for="chat in chats" :key="chat.value"
          ><input
            type="checkbox"
            :checked="modelValue.chatIds.includes(chat.value)"
            @change="
              select(chat.value, ($event.target as HTMLInputElement).checked)
            "
          />{{ chat.label }}</label
        >
        <p v-if="!modelValue.chatIds.length">
          请选择聊天；同一聊天只能绑定一个提醒工作流。
        </p>
      </fieldset>
      <label
        >提醒时区（IANA）<input
          :value="modelValue.timeZone"
          @change="
            update({ timeZone: ($event.target as HTMLInputElement).value })
          "
      /></label>
      <label
        >每成员每聊天待执行上限<input
          type="number"
          min="1"
          max="100"
          :value="modelValue.memberPendingLimit"
          @change="
            update({
              memberPendingLimit: Number(
                ($event.target as HTMLInputElement).value,
              ),
            })
          "
      /></label>
      <p>关闭此功能或移除聊天会取消未发送任务，重新开启不会恢复旧任务。</p>
    </template>
  </section>
</template>
<style scoped>
.scheduled-settings {
  display: grid;
  gap: 12px;
  border-top: 1px solid var(--border-color, #e5e7eb);
  padding-top: 16px;
  margin-top: 16px;
}
.scheduled-settings label {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.scheduled-settings fieldset {
  display: grid;
  gap: 8px;
  max-height: 220px;
  overflow: auto;
}
.scheduled-settings p {
  font-size: 13px;
  color: var(--text-muted, #64748b);
}
</style>
