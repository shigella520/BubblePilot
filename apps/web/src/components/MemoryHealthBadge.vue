<script setup lang="ts">
import { computed } from "vue";
import {
  Circle,
  CircleCheck,
  CircleHelp,
  CircleSlash,
  CircleX,
  LoaderCircle,
  RefreshCcw,
  TriangleAlert,
} from "@lucide/vue";
import {
  healthShortText,
  healthTitle,
  type MemoryChatHealth,
} from "../utils/memory-health";
import { statusLabel } from "../utils/status-labels";

/** Long-term retrieval health: icon + short text, details on hover. */
const props = defineProps<{ health: MemoryChatHealth | null | undefined }>();
const icons = {
  healthy: CircleCheck,
  indexing: LoaderCircle,
  missing: TriangleAlert,
  "rebuild-required": RefreshCcw,
  "service-error": CircleX,
  "global-off": CircleSlash,
  disabled: Circle,
};
const view = computed(() => {
  const state = props.health?.state;
  return {
    icon: state ? icons[state] : CircleHelp,
    tone: state ? statusLabel("memoryHealth", state).tone : "neutral",
    text: healthShortText(props.health),
    title: healthTitle(props.health),
  };
});
</script>

<template>
  <span
    class="memory-health"
    :class="[`tone-${view.tone}`, health?.state]"
    :title="view.title"
  >
    <component :is="view.icon" :size="15" aria-hidden="true" /><span>{{
      view.text
    }}</span>
  </span>
</template>

<style scoped>
.memory-health {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--bubblepilot-text-sm);
  font-weight: 700;
  white-space: nowrap;
}
.memory-health.tone-success {
  color: var(--bubblepilot-success);
}
.memory-health.tone-info {
  color: var(--bubblepilot-info);
}
.memory-health.tone-warning {
  color: var(--bubblepilot-warning);
}
.memory-health.tone-danger {
  color: var(--bubblepilot-danger);
}
.memory-health.tone-neutral {
  color: var(--bubblepilot-muted);
}
.memory-health.indexing svg {
  animation: memory-health-spin 1.6s linear infinite;
}
@keyframes memory-health-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .memory-health.indexing svg {
    animation: none;
  }
}
</style>
