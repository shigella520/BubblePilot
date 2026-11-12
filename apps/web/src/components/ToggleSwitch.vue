<script setup lang="ts">
const checked = defineModel<boolean>({ required: true });
defineProps<{ label: string; disabled?: boolean }>();
</script>

<template>
  <button
    type="button"
    class="toggle-switch"
    role="switch"
    :aria-label="label"
    :aria-checked="checked"
    :disabled="disabled"
    @click="checked = !checked"
  >
    <span aria-hidden="true" />
  </button>
</template>

<style scoped>
.toggle-switch {
  width: 38px;
  height: 23px;
  padding: 3px;
  border: 0;
  border-radius: 20px;
  background: #cbd5e1;
  flex-shrink: 0;
  cursor: pointer;
}
.toggle-switch span {
  display: block;
  width: 17px;
  height: 17px;
  background: white;
  border-radius: 50%;
  box-shadow: 0 1px 3px #0002;
  transition: transform 0.15s;
}
.toggle-switch[aria-checked="true"] {
  background: #2563eb;
}
.toggle-switch[aria-checked="true"] span {
  transform: translateX(15px);
}
.toggle-switch:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.toggle-switch:focus-visible {
  outline: 2px solid var(--bubblepilot-accent);
  outline-offset: 3px;
}
@media (prefers-reduced-motion: reduce) {
  .toggle-switch span {
    transition: none;
  }
}
</style>
