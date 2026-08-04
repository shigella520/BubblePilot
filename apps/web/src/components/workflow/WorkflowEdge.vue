<script setup lang="ts">
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@vue-flow/core";
import { computed } from "vue";
const props = defineProps<
  EdgeProps & { kind?: string; data?: { kind?: string; label?: string } }
>();
const emit = defineEmits<{ (event: "delete", id: string): void }>();
// Vue Flow updates the edge coordinates when either endpoint moves. Keep the
// path derived from reactive props so the SVG follows the nodes immediately.
const pathData = computed(() => getBezierPath(props));
const edgeClass = computed(
  () => `workflow-edge-${props.data?.kind ?? props.kind ?? "success"}`,
);
</script>
<template>
  <BaseEdge
    :id="id"
    :path="pathData[0]"
    :class="edgeClass"
    marker-end="url(#workflow-arrow)"
  />
  <EdgeLabelRenderer v-if="data?.label">
    <span
      class="workflow-edge-label"
      :style="{
        transform: `translate(-50%, -50%) translate(${pathData[1]}px,${pathData[2]}px)`,
      }"
      >{{ data.label }}</span
    >
  </EdgeLabelRenderer>
  <EdgeLabelRenderer>
    <button
      class="workflow-edge-delete"
      type="button"
      :style="{
        transform: `translate(-50%, -50%) translate(${pathData[1]}px,${pathData[2] + 16}px)`,
      }"
      @click.stop="emit('delete', id)"
    >
      ×
    </button>
  </EdgeLabelRenderer>
</template>
