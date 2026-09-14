<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, useId } from "vue";
import { X } from "@lucide/vue";
const props = defineProps<{
  title: string;
  returnFocus?: HTMLElement | null;
}>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const titleId = useId();
let previous: HTMLElement | null = null;
onMounted(() => {
  previous =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  dialog.value?.showModal();
});
onBeforeUnmount(() => {
  dialog.value?.close();
  const target = props.returnFocus ?? previous;
  if (target?.isConnected) target.focus();
});
</script>
<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="admin-detail-dialog"
      :aria-labelledby="titleId"
      @cancel.prevent="emit('close')"
      @click.self="emit('close')"
    >
      <section>
        <header class="panel-head">
          <h2 :id="titleId">{{ title }}</h2>
          <button
            class="button secondary"
            type="button"
            aria-label="关闭详情"
            @click="emit('close')"
          >
            <X :size="18" />关闭
          </button>
        </header>
        <div class="admin-detail-body"><slot /></div>
      </section>
    </dialog>
  </Teleport>
</template>
<style scoped>
.admin-detail-dialog {
  border: 1px solid #e0e4e8;
  border-radius: 20px;
  padding: 0;
  width: min(900px, calc(100vw - 32px));
  max-height: calc(100dvh - 48px);
  background: #fafbfc;
  color: inherit;
  box-shadow: 0 24px 80px #16233833;
}
.admin-detail-dialog::backdrop {
  background: #16233870;
}
.panel-head {
  padding: 20px 24px;
  margin: 0;
  border-bottom: 1px solid #e0e4e8;
}
.admin-detail-body {
  padding: 20px 24px;
  max-height: calc(100dvh - 160px);
  overflow: auto;
  overflow-wrap: anywhere;
}
:deep(pre) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
