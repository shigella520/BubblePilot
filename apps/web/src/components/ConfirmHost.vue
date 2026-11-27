<script setup lang="ts">
import { nextTick, ref, useId, watch } from "vue";
import { AlertTriangle } from "@lucide/vue";
import { confirmState } from "../services/confirm";

const dialog = ref<HTMLDialogElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
const confirmButton = ref<HTMLButtonElement | null>(null);
const titleId = useId();
const messageId = useId();
let previous: HTMLElement | null = null;

watch(
  () => confirmState.current,
  async (request) => {
    if (request) {
      previous =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      await nextTick();
      if (!dialog.value?.open) dialog.value?.showModal();
      // Destructive actions start on “取消” so Enter does not destroy data.
      (request.danger ? cancelButton.value : confirmButton.value)?.focus();
    } else {
      dialog.value?.close();
      if (previous?.isConnected) previous.focus();
      previous = null;
    }
  },
);
function answer(ok: boolean) {
  confirmState.current?.resolve(ok);
}
</script>

<template>
  <Teleport to="body">
    <dialog
      v-show="confirmState.current"
      ref="dialog"
      class="confirm-dialog"
      :aria-labelledby="titleId"
      :aria-describedby="messageId"
      @cancel.prevent="answer(false)"
    >
      <template v-if="confirmState.current">
        <h2 :id="titleId">
          <AlertTriangle
            v-if="confirmState.current.danger"
            :size="20"
            aria-hidden="true"
          />{{ confirmState.current.title }}
        </h2>
        <p :id="messageId">{{ confirmState.current.message }}</p>
        <div class="confirm-actions">
          <button
            ref="cancelButton"
            class="button secondary"
            type="button"
            @click="answer(false)"
          >
            取消</button
          ><button
            ref="confirmButton"
            class="button"
            :class="confirmState.current.danger ? 'danger' : 'primary'"
            type="button"
            @click="answer(true)"
          >
            {{ confirmState.current.confirmText }}
          </button>
        </div>
      </template>
    </dialog>
  </Teleport>
</template>

<style scoped>
.confirm-dialog {
  width: min(460px, calc(100vw - 32px));
  padding: 24px;
  border: 1px solid var(--bubblepilot-line-strong);
  border-radius: var(--bubblepilot-radius-md);
  color: var(--bubblepilot-text);
  background: var(--bubblepilot-surface);
  box-shadow: var(--bubblepilot-shadow);
}
.confirm-dialog::backdrop {
  background: rgba(22, 35, 56, 0.44);
}
.confirm-dialog h2 {
  display: flex;
  align-items: center;
  gap: var(--bubblepilot-space-2);
  margin: 0 0 var(--bubblepilot-space-3);
  font-size: var(--bubblepilot-text-lg);
}
.confirm-dialog h2 svg {
  color: var(--bubblepilot-danger);
}
.confirm-dialog p {
  margin: 0 0 var(--bubblepilot-space-5);
  color: var(--bubblepilot-muted);
  line-height: 1.6;
  white-space: pre-line;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--bubblepilot-space-2);
}
</style>
