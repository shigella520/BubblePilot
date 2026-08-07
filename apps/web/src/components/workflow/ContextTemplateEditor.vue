<script setup lang="ts">
import { nextTick, ref } from "vue";

interface TemplateReference {
  token: string;
  label: string;
}

const props = defineProps<{
  modelValue: string;
  references: TemplateReference[];
}>();
const emit = defineEmits<{
  (event: "update:modelValue", value: string): void;
}>();

const textarea = ref<HTMLTextAreaElement | null>(null);
const selectedToken = ref("");

function updateValue(event: Event) {
  emit("update:modelValue", (event.target as HTMLTextAreaElement).value);
}

async function insertToken() {
  if (!selectedToken.value) return;
  const element = textarea.value;
  const start = element?.selectionStart ?? props.modelValue.length;
  const end = element?.selectionEnd ?? start;
  const insertion = `{{${selectedToken.value}}}`;
  emit(
    "update:modelValue",
    `${props.modelValue.slice(0, start)}${insertion}${props.modelValue.slice(end)}`,
  );
  await nextTick();
  const cursor = start + insertion.length;
  textarea.value?.focus();
  textarea.value?.setSelectionRange(cursor, cursor);
}
</script>

<template>
  <div class="workflow-template-editor">
    <textarea
      ref="textarea"
      :value="props.modelValue"
      rows="10"
      spellcheck="false"
      @input="updateValue"
    ></textarea>
    <div class="workflow-template-toolbar">
      <select v-model="selectedToken">
        <option value="">选择 Context 内容…</option>
        <option
          v-for="reference in props.references"
          :key="reference.token"
          :value="reference.token"
        >
          {{ reference.label }} · {{ reference.token }}
        </option>
      </select>
      <button
        class="button secondary"
        type="button"
        :disabled="!selectedToken"
        @click="insertToken"
      >
        插入
      </button>
    </div>
    <small
      >模板使用
      <code v-pre>{{ context.event.message.text }}</code> 语法。</small
    >
  </div>
</template>
