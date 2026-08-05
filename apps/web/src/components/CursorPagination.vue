<script setup lang="ts">
import { ChevronLeft, ChevronRight } from "@lucide/vue";

defineProps<{
  page: number;
  itemCount: number;
  busy: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
}>();

defineEmits<{
  previous: [];
  next: [];
}>();
</script>

<template>
  <nav
    v-if="page > 1 || hasNext"
    class="cursor-pagination"
    aria-label="列表分页"
  >
    <span>第 {{ page }} 页 · 本页 {{ itemCount }} 条</span>
    <div class="row-actions">
      <button
        class="button tiny secondary"
        type="button"
        :disabled="busy || !hasPrevious"
        @click="$emit('previous')"
      >
        <ChevronLeft :size="15" />上一页
      </button>
      <button
        class="button tiny secondary"
        type="button"
        :disabled="busy || !hasNext"
        @click="$emit('next')"
      >
        下一页<ChevronRight :size="15" />
      </button>
    </div>
  </nav>
</template>
