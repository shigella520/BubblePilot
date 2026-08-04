<script setup lang="ts">
import { X } from "@lucide/vue";

defineProps<{ error?: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Teleport to="body">
    <div class="form-message" :class="{ error }" role="alert">
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
