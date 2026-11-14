<script setup lang="ts">
import { computed, ref, watch } from "vue";
import SensitiveUnlock from "./SensitiveUnlock.vue";
import { useSessionStore } from "../stores/session";
import AdminDetailDialog from "./AdminDetailDialog.vue";
const props = withDefaults(
  defineProps<{
    title: string;
    busy?: boolean;
    savedVersion?: unknown;
    draft?: unknown;
    sensitiveRequired?: boolean;
  }>(),
  { sensitiveRequired: true, savedVersion: undefined, draft: undefined },
);
const emit = defineEmits<{ close: [] }>();
const session = useSessionStore();
const baseline = ref(JSON.stringify(props.draft));
const dirty = ref(false);
const confirmingClose = ref(false);
const hasChanges = computed(() =>
  props.draft === undefined
    ? dirty.value
    : JSON.stringify(props.draft) !== baseline.value,
);
watch(
  () => props.savedVersion,
  () => {
    dirty.value = false;
    baseline.value = JSON.stringify(props.draft);
  },
);
function close() {
  if (props.busy) return;
  if (hasChanges.value) {
    confirmingClose.value = true;
    return;
  }
  emit("close");
}
defineExpose({ close });
</script>
<template>
  <AdminDetailDialog :title="title" @close="close">
    <SensitiveUnlock v-if="sensitiveRequired && !session.sensitiveActive" />
    <fieldset
      class="dialog-form-content"
      :disabled="busy"
      :aria-busy="busy"
      @input="dirty = true"
      @change="dirty = true"
    >
      <slot />
    </fieldset>
    <div v-if="confirmingClose" class="dialog-discard" role="alert">
      <p>有尚未保存的修改，关闭后将丢弃。</p>
      <button
        type="button"
        class="button secondary"
        :disabled="busy"
        @click="confirmingClose = false"
      >
        继续编辑
      </button>
      <button
        type="button"
        class="button danger-ghost"
        :disabled="busy"
        @click="!busy && emit('close')"
      >
        放弃修改并关闭
      </button>
    </div>
    <footer class="dialog-form-footer">
      <button
        type="button"
        class="button secondary"
        :disabled="busy"
        @click="close"
      >
        关闭
      </button>
      <slot name="actions" />
    </footer>
  </AdminDetailDialog>
</template>
<style scoped>
.dialog-discard {
  margin-top: 16px;
  padding: 16px;
  border-radius: 12px;
  background: #fff5e6;
}
.dialog-discard button {
  margin: 4px;
}
.dialog-form-content {
  display: block;
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.dialog-form-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 9px;
  justify-content: flex-end;
  margin-top: 20px;
}
</style>
