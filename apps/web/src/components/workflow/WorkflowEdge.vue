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
  EdgeProps & { data?: { kind?: string; label?: string } }
>();
const emit = defineEmits<{ (event: "delete", id: string): void }>();
const [path, labelX, labelY] = getBezierPath(props);
const edgeClass = computed(
  () => `workflow-edge-${props.data?.kind ?? "success"}`,
);
</script>
<template>
  <BaseEdge
    :id="id"
    :path="path"
    :class="edgeClass"
    marker-end="url(#workflow-arrow)"
  />
  <EdgeLabelRenderer v-if="data?.label">
    <span
      class="workflow-edge-label"
      :style="{
        transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
      }"
      >{{ data.label }}</span
    >
  </EdgeLabelRenderer>
  <EdgeLabelRenderer>
    <button
      class="workflow-edge-delete"
      type="button"
      :style="{
        transform: `translate(-50%, -50%) translate(${labelX}px,${labelY + 16}px)`,
      }"
      @click.stop="emit('delete', id)"
    >
      ×
    </button>
  </EdgeLabelRenderer>
</template>
