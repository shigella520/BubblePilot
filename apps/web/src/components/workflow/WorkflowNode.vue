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
    <div class="workflow-node-head">
      <div class="workflow-node-title">
        <span class="workflow-node-dot"></span>
        <strong>{{ data.label }}</strong>
      </div>
      <small>{{ data.block.description }}</small>
      <span v-if="data.status" class="workflow-node-status">{{
        data.status
      }}</span>
    </div>
    <div class="workflow-node-ports">
      <div
        v-if="data.block.type !== 'message-trigger'"
        class="workflow-port-row workflow-port-row-input control-row"
      >
        <Handle
          id="control"
          class="workflow-handle control-input"
          type="target"
          :position="Position.Left"
        />
        <span>流程输入</span><em>控制</em>
      </div>
      <div
        v-for="port in data.block.inputs"
        :key="`input-${port.name}`"
        class="workflow-port-row workflow-port-row-input"
      >
        <Handle
          :id="`input:${port.name}`"
          class="workflow-handle data-input"
          type="target"
          :position="Position.Left"
        />
        <span>{{ port.label }}</span
        ><em>{{ port.type }}</em>
      </div>
      <div
        v-for="port in data.block.outputs"
        :key="`output-${port.name}`"
        class="workflow-port-row workflow-port-row-output"
      >
        <span>{{ port.label }}</span
        ><em>{{ port.type }}</em>
        <Handle
          :id="`output:${port.name}`"
          class="workflow-handle data-output"
          type="source"
          :position="Position.Right"
        />
      </div>
      <template v-if="data.block.branches?.length">
        <div
          v-for="branch in data.block.branches"
          :key="branch.name"
          class="workflow-port-row workflow-port-row-output branch-row"
        >
          <span>{{ branch.label }}</span
          ><em>分支</em>
          <Handle
            :id="branch.name === 'onTrue' ? 'true' : 'false'"
            class="workflow-handle branch"
            type="source"
            :position="Position.Right"
          />
          <button
            type="button"
            class="workflow-port-add"
            @click.stop="
              emit('add', branch.name === 'onTrue' ? 'true' : 'false')
            "
          >
            ＋
          </button>
        </div>
      </template>
      <template v-else>
        <div class="workflow-port-row workflow-port-row-output success-row">
          <span>成功</span><em>控制</em>
          <Handle
            id="success"
            class="workflow-handle success"
            type="source"
            :position="Position.Right"
          />
          <button
            type="button"
            class="workflow-port-add"
            @click.stop="emit('add', 'success')"
          >
            ＋
          </button>
        </div>
        <div
          v-if="controlFailure"
          class="workflow-port-row workflow-port-row-output failure-row"
        >
          <span>失败</span><em>控制</em>
          <Handle
            id="failure"
            class="workflow-handle failure"
            type="source"
            :position="Position.Right"
          />
          <button
            type="button"
            class="workflow-port-add"
            @click.stop="emit('add', 'failure')"
          >
            ＋
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
