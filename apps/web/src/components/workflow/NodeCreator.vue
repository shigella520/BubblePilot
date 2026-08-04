<script setup lang="ts">
/* eslint-disable @typescript-eslint/no-explicit-any */
import { computed, ref } from "vue";
interface Port { name: string; label: string; type: string }
interface Block { type: string; version: number; name: string; description: string; category: string; inputs: Port[]; outputs: Port[]; config: any[] }
const props = defineProps<{ blocks: Block[]; open: boolean }>();
const emit = defineEmits<{ (event: "select", block: Block): void; (event: "close"): void }>();
const query = ref("");
const filtered = computed(() => props.blocks.filter((block) => `${block.name} ${block.description} ${block.category}`.toLowerCase().includes(query.value.toLowerCase())).slice(0, 30));
</script>
<template>
  <aside v-if="open" class="workflow-node-creator">
    <div class="workflow-node-creator-head"><strong>添加动作</strong><button type="button" @click="emit('close')">×</button></div>
    <input v-model="query" autofocus placeholder="搜索动作名称或类别…" />
    <button v-for="block in filtered" :key="`${block.type}@${(block as any).version ?? 1}`" class="workflow-node-result" type="button" @click="emit('select', block)">
      <strong>{{ block.name }}</strong><small>{{ block.description }}</small>
    </button>
    <p v-if="!filtered.length" class="workflow-node-creator-empty">没有匹配的动作</p>
  </aside>
</template>
