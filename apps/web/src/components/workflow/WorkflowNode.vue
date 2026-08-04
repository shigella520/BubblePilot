<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";

interface Port {
  name: string;
  label: string;
  type: string;
}
interface Block {
  type: string;
  name: string;
  description: string;
  inputs: Port[];
  outputs: Port[];
  branches?: Array<{ name: string; label: string }>;
}
const props = defineProps<{
  data: { label: string; block: Block; status?: string };
}>();
const emit = defineEmits<{ (event: "add", handle: string): void }>();
const controlFailure = ["load-context", "ai-chat", "reply"].includes(
  props.data.block.type,
);
</script>

<template>
  <div class="workflow-node-card" :data-node-type="data.block.type">
    <Handle
      id="control"
      class="workflow-handle control-input"
      type="target"
      :position="Position.Left"
    />
    <div class="workflow-node-title">
      <span class="workflow-node-dot"></span>
      <strong>{{ data.label }}</strong>
    </div>
    <small class="workflow-node-type">{{ data.block.description }}</small>
    <span v-if="data.status" class="workflow-node-status">{{
      data.status
    }}</span>

    <div
      v-for="(port, index) in data.block.inputs"
      :key="`input-${port.name}`"
      class="workflow-port-label workflow-port-input"
      :style="{ top: `${42 + Number(index) * 16}%` }"
    >
      <Handle
        :id="`input:${port.name}`"
        class="workflow-handle data-input"
        type="target"
        :position="Position.Left"
      />
      <span>{{ port.label }}</span>
    </div>
    <div
      v-for="(port, index) in data.block.outputs"
      :key="`output-${port.name}`"
      class="workflow-port-label workflow-port-output"
      :style="{ top: `${42 + Number(index) * 16}%` }"
    >
      <span>{{ port.label }}</span>
      <Handle
        :id="`output:${port.name}`"
        class="workflow-handle data-output"
        type="source"
        :position="Position.Right"
      />
    </div>
    <template v-if="data.block.branches?.length">
      <div
        v-for="(branch, index) in data.block.branches"
        :key="branch.name"
        class="workflow-port-label workflow-port-output workflow-port-branch"
        :style="{ top: `${78 + Number(index) * 17}%` }"
      >
        <span>{{ branch.label }}</span>
        <Handle
          :id="branch.name === 'onTrue' ? 'true' : 'false'"
          class="workflow-handle branch"
          type="source"
          :position="Position.Right"
        />
      </div>
    </template>
    <template v-else>
      <div
        class="workflow-port-label workflow-port-output workflow-port-control"
      >
        <span>成功</span
        ><Handle
          id="success"
          class="workflow-handle success"
          type="source"
          :position="Position.Right"
        />
      </div>
      <div
        v-if="controlFailure"
        class="workflow-port-label workflow-port-output workflow-port-control workflow-port-failure"
      >
        <span>失败</span
        ><Handle
          id="failure"
          class="workflow-handle failure"
          type="source"
          :position="Position.Right"
        />
      </div>
    </template>
    <button
      class="workflow-node-add"
      type="button"
      title="从此端口添加动作"
      @click.stop="emit('add', 'success')"
    >
      ＋
    </button>
  </div>
</template>
