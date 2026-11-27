<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

/**
 * Native <dialog> wrapper for pages that render their own dialog layout:
 * focus is trapped and restored, Esc and backdrop clicks request close (the
 * page decides, e.g. to confirm discarding edits), the page behind is inert.
 */
defineProps<{ labelledby: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
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
  if (previous?.isConnected) previous.focus();
});
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="modal-shell"
      :aria-labelledby="labelledby"
      @cancel.prevent="emit('close')"
      @click.self="emit('close')"
    >
      <slot />
    </dialog>
  </Teleport>
</template>

<style scoped>
.modal-shell {
  max-width: calc(100vw - 32px);
  max-height: calc(100dvh - 32px);
  padding: 0;
  border: 0;
  background: transparent;
  overflow: visible;
}
.modal-shell::backdrop {
  background: rgba(22, 35, 56, 0.44);
}
</style>
