<script setup lang="ts">
import { ref } from "vue";

/** Short, copyable identifier: shows a prefix, full value on hover/click. */
const props = withDefaults(defineProps<{ value: string; length?: number }>(), {
  length: 8,
});
const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
async function copy() {
  try {
    await navigator.clipboard.writeText(props.value);
    copied.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied.value = false), 1500);
  } catch {
    // Clipboard may be unavailable (insecure context); the title still shows it.
  }
}
</script>

<template>
  <button
    type="button"
    class="copyable-id"
    :title="`${value}（点击复制）`"
    :aria-label="`复制 ID ${value}`"
    @click.stop="copy"
  >
    {{ copied ? "已复制" : value.slice(0, length) }}
  </button>
</template>

<style scoped>
.copyable-id {
  padding: 0 4px;
  border: 0;
  border-radius: 6px;
  color: var(--bubblepilot-muted);
  background: transparent;
  font-family: var(--bubblepilot-font-mono);
  font-size: var(--bubblepilot-text-xs);
  cursor: copy;
}
.copyable-id:hover {
  color: var(--bubblepilot-text);
  background: var(--bubblepilot-neutral-bg);
}
.copyable-id:focus-visible {
  outline: none;
  box-shadow: var(--bubblepilot-focus-ring);
}
</style>
