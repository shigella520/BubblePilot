<script setup lang="ts">
import { KeyRound } from "@lucide/vue";
import { useSessionStore } from "../stores/session";

/** Explains why something is locked and unlocks in place (no "go to header"). */
defineProps<{ reason?: string; compact?: boolean }>();
const session = useSessionStore();
</script>

<template>
  <span
    v-if="!session.sensitiveActive"
    class="locked-hint"
    :class="{ compact }"
    role="note"
  >
    <KeyRound :size="14" aria-hidden="true" />
    <span>{{ reason ?? "需要敏感操作授权" }}</span>
    <button
      class="button secondary tiny"
      type="button"
      @click="session.requestUnlock()"
    >
      立即解锁
    </button>
  </span>
</template>

<style scoped>
.locked-hint {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--bubblepilot-space-2);
  color: var(--bubblepilot-warning);
  font-size: var(--bubblepilot-text-sm);
}
.locked-hint:not(.compact) {
  padding: var(--bubblepilot-space-2) var(--bubblepilot-space-3);
  border: 1px solid var(--bubblepilot-warning-line);
  border-radius: var(--bubblepilot-radius-sm);
  background: var(--bubblepilot-warning-bg);
}
</style>
