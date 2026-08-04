<script setup lang="ts">
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-redundant-type-constituents, vue/no-mutating-props */
const props = defineProps<{ node: any | null; config: Record<string, any> }>();
const emit = defineEmits<{ (event: "update:name", value: string): void; (event: "remove"): void; (event: "close"): void }>();
</script>
<template>
  <aside v-if="node" class="workflow-node-inspector">
    <div class="workflow-inspector-head"><div><small>动作块</small><h3>{{ node.data.label }}</h3></div><button type="button" @click="emit('close')">×</button></div>
    <label>节点名称<input :value="node.data.label" maxlength="80" @input="emit('update:name', ($event.target as HTMLInputElement).value)" /></label>
    <p class="workflow-inspector-description">{{ node.data.block.description }}</p>
    <div v-for="item in node.data.block.config" :key="item.name" class="workflow-inspector-field">
      <label><span>{{ item.label }}</span><select v-if="item.type === 'select'" v-model="props.config[item.name]"><option v-for="option in item.options ?? []" :key="option.value" :value="option.value">{{ option.label }}</option></select><input v-else-if="item.type !== 'boolean'" v-model="props.config[item.name]" :type="item.type === 'number' ? 'number' : 'text'" /><input v-else v-model="props.config[item.name]" type="checkbox" /></label>
      <small>{{ item.description }}</small>
    </div>
    <div v-if="node.data.block.inputs.length" class="workflow-inspector-refs"><strong>输入引用</strong><span v-for="input in node.data.block.inputs" :key="input.name">{{ input.label }}：{{ node.data.inputs?.[input.name]?.kind === 'output' ? `${node.data.inputs[input.name].blockId} / ${node.data.inputs[input.name].port}` : '固定值或未连接' }}</span></div>
    <button class="button danger" type="button" @click="emit('remove')">删除动作块</button>
  </aside>
</template>
