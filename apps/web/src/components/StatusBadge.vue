<script setup lang="ts">
import { computed } from "vue";
import {
  statusLabel,
  type StatusDomain,
  type StatusTone,
} from "../utils/status-labels";

const props = defineProps<{
  domain?: StatusDomain;
  status?: string | null;
  /** Explicit label/tone for states outside the shared dictionary. */
  label?: string;
  tone?: StatusTone;
}>();
const resolved = computed(() => {
  const base = props.domain
    ? statusLabel(props.domain, props.status)
    : { label: props.status ?? "—", tone: "neutral" as StatusTone };
  return { label: props.label ?? base.label, tone: props.tone ?? base.tone };
});
</script>

<template>
  <span
    class="table-status"
    :class="`tone-${resolved.tone}`"
    :title="status && status !== resolved.label ? status : undefined"
    ><slot />{{ resolved.label }}</span
  >
</template>
