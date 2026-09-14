<script setup lang="ts">
import { X } from "@lucide/vue";

defineProps<{ error?: boolean; inline?: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Teleport to="body" :disabled="inline">
    <div
      class="form-message"
      :class="{ error, 'inline-message': inline }"
      role="alert"
    >
      <span class="form-message-content"><slot /></span>
      <button
        class="form-message-close"
        type="button"
        aria-label="关闭提示"
        title="关闭提示"
        @click="emit('close')"
      >
        <X :size="15" />
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.inline-message {
  position: static;
  transform: none;
  width: auto;
  max-width: none;
  margin: 0 0 1rem;
}
</style>
