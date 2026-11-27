<script setup lang="ts">
import { Puzzle, Smile } from "@lucide/vue";

/** Plugins and memes share one top-level navigation entry. */
</script>

<template>
  <nav class="extension-tabs" aria-label="插件与表情包">
    <RouterLink class="extension-tab" to="/plugins" active-class="is-current"
      ><Puzzle :size="16" />插件</RouterLink
    >
    <RouterLink class="extension-tab" to="/memes" active-class="is-current"
      ><Smile :size="16" />表情包</RouterLink
    >
  </nav>
</template>

<style scoped>
.extension-tabs {
  display: inline-flex;
  gap: var(--bubblepilot-space-1);
  margin-bottom: var(--bubblepilot-space-4);
  padding: var(--bubblepilot-space-1);
  border: 1px solid var(--bubblepilot-line);
  border-radius: 999px;
  background: rgba(245, 244, 240, 0.8);
}
.extension-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 999px;
  color: var(--bubblepilot-muted);
  font-size: var(--bubblepilot-text-sm);
  font-weight: 750;
}
.extension-tab.is-current {
  color: var(--bubblepilot-text);
  background: var(--bubblepilot-surface);
  box-shadow: var(--bubblepilot-shadow-soft);
}
.extension-tab:focus-visible {
  outline: none;
  box-shadow: var(--bubblepilot-focus-ring);
}
</style>
