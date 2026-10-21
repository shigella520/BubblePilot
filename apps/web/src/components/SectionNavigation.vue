<script setup lang="ts">
import type { Component } from "vue";
import { useSectionNavigation } from "../composables/useSectionNavigation";

const props = defineProps<{
  items: { id: string; label: string; icon: Component }[];
}>();
const { navigation, activeId, orderedItems, indicator, navigate } =
  useSectionNavigation(props);
</script>

<template>
  <nav ref="navigation" class="section-navigation" aria-label="页面模块">
    <span class="section-indicator" :style="indicator" aria-hidden="true" />
    <button
      v-for="item in orderedItems"
      :key="item.id"
      type="button"
      :class="{ 'section-current': activeId === item.id }"
      :aria-current="activeId === item.id ? 'location' : undefined"
      :aria-controls="item.id"
      @click="navigate(item.id)"
    >
      <component :is="item.icon" :size="18" />{{ item.label }}
    </button>
  </nav>
</template>

<style scoped>
.section-navigation {
  position: relative;
  isolation: isolate;
}
.section-indicator {
  position: absolute;
  top: 0;
  left: 0;
  z-index: -1;
  pointer-events: none;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.85);
  box-shadow: 0 9px 20px rgba(16, 19, 23, 0.05);
}
.section-navigation button.section-current,
.section-navigation button:hover {
  color: var(--bubblepilot-text);
  background: transparent;
  box-shadow: none;
}
.section-navigation button:focus-visible {
  outline: 2px solid var(--bubblepilot-text);
  outline-offset: -2px;
}
</style>
