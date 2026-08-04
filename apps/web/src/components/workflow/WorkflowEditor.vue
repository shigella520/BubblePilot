<script setup lang="ts">
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-redundant-type-constituents */
import { computed, ref, watch } from "vue";
import { VueFlow, Handle, Position, type Connection } from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";

interface Block {
  type: string;
  version: number;
  name: string;
  description: string;
  category: string;
  inputs: Array<{
    name: string;
    label: string;
    type: string;
    required?: boolean;
  }>;
  outputs: Array<{ name: string; label: string; type: string }>;
  config: Array<{
    name: string;
    label: string;
    type: string;
    required?: boolean;
    options?: Array<{ value: string; label: string }>;
  }>;
  branches?: Array<{ name: string; label: string }>;
}
const props = defineProps<{
  blocks: Block[];
  workflowName?: string;
  definition?: any;
}>();
const emit = defineEmits<{
  (e: "create", name: string, definition: any): void;
  (e: "version", name: string, definition: any): void;
}>();
const name = ref(props.workflowName ?? "");
const nodes = ref<any[]>([]);
const edges = ref<any[]>([]);
const selected = ref<any | null>(null);
const config = ref<Record<string, any>>({});
let hydratedDefinition = "";
watch(
  () => props.workflowName,
  (value) => {
    if (value) name.value = value;
  },
);
const grouped = computed(() =>
  props.blocks.reduce(
    (map, block) => {
      (map[block.category] ??= []).push(block);
      return map;
    },
    {} as Record<string, Block[]>,
  ),
);
function addBlock(block: Block) {
  const id = `${block.type}-${Date.now()}`;
  nodes.value.push({
    id,
    type: "action",
    position: {
      x: 80 + nodes.value.length * 30,
      y: 80 + nodes.value.length * 30,
    },
    data: { label: block.name, block, config: defaultConfig(block) },
  });
  selected.value = nodes.value[nodes.value.length - 1];
  config.value = {};
}
function hydrate(definition: any) {
  if (!definition || hydratedDefinition === JSON.stringify(definition)) return;
  const sourceNodes = (
    Array.isArray(definition.nodes) ? definition.nodes : []
  ) as Array<Record<string, any>>;
  nodes.value = sourceNodes.map((item: any, index: number) => {
    const block = props.blocks.find(
      (candidate) => candidate.type === item.type,
    ) ?? {
      type: item.type,
      version: item.version ?? 1,
      name: item.type,
      description: "",
      category: "",
      inputs: [],
      outputs: [],
      config: [],
    };
    return {
      id: item.id,
      type: "action",
      position: item.position ?? { x: 80 + index * 220, y: 100 },
      data: {
        label: block.name,
        block,
        config: { ...(item.config ?? {}) },
        inputs: item.inputs ?? {},
      },
    };
  });
  const edgeList: any[] = [];
  for (const item of sourceNodes) {
    for (const [kind, target] of [
      ["success", item.onSuccess],
      ["failure", item.onFailure],
    ] as const) {
      if (typeof target === "string")
        edgeList.push({
          id: `${item.id}-${kind}-${target}`,
          source: item.id,
          sourceHandle: kind,
          target,
          targetHandle: "control",
          kind,
        });
    }
    for (const [port, reference] of Object.entries(
      (item.inputs ?? {}) as Record<string, unknown>,
    )) {
      if (
        reference &&
        typeof reference === "object" &&
        (reference as any).kind === "output"
      ) {
        edgeList.push({
          id: `${(reference as any).blockId}-output-${(reference as any).port}-${item.id}-${port}`,
          source: (reference as any).blockId,
          sourceHandle: `output:${(reference as any).port}`,
          target: item.id,
          targetHandle: `input:${port}`,
          kind: "data",
        });
      }
    }
  }
  edges.value = edgeList;
  hydratedDefinition = JSON.stringify(definition);
}
watch(
  () => props.definition,
  (definition) => {
    if (definition === undefined) {
      nodes.value = [];
      edges.value = [];
      selected.value = null;
      config.value = {};
      hydratedDefinition = "";
      return;
    }
    hydrate(definition);
  },
  { immediate: true, deep: true },
);
function defaultConfig(block: Block): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const item of block.config) {
    if (item.type === "boolean") values[item.name] = false;
    else if (item.type === "select")
      values[item.name] = item.options?.[0]?.value ?? "";
    else
      values[item.name] =
        item.name === "promptTemplate" ? "请根据聊天上下文回答当前消息。" : "";
  }
  if (block.type === "load-context")
    Object.assign(values, {
      messageLimit: 10,
      characterLimit: 6000,
      includeFromMe: true,
    });
  if (block.type === "ai-chat")
    Object.assign(values, {
      timeoutMs: 60000,
      maxOutputTokens: 1024,
      maxOutputCharacters: 4000,
      temperature: null,
      outputVariable: "aiReply",
      includeLoadedContext: true,
    });
  if (block.type === "reply")
    Object.assign(values, {
      text: "{{variables.aiReply}}",
      replyToSourceMessage: false,
      retry: { maxAttempts: 2, initialDelayMs: 250 },
    });
  if (block.type === "end") values.result = "succeeded";
  return values;
}
function dragStart(event: DragEvent, block: Block) {
  event.dataTransfer?.setData(
    "application/x-action-block",
    JSON.stringify(block),
  );
}
function drop(event: DragEvent) {
  const raw = event.dataTransfer?.getData("application/x-action-block");
  if (!raw) return;
  addBlock(JSON.parse(raw) as Block);
}
function selectNode(node: any) {
  selected.value = node;
  config.value = { ...(node.data.config ?? {}) };
}
function removeSelected() {
  if (!selected.value) return;
  const id = selected.value.id;
  nodes.value = nodes.value.filter((node) => node.id !== id);
  edges.value = edges.value.filter(
    (edge) => edge.source !== id && edge.target !== id,
  );
  selected.value = null;
  config.value = {};
}
function save() {
  const orderedNodes = nodes.value;
  const runtimeOrder = orderedNodes;
  const connectedNext = new Map(
    edges.value
      .filter((edge) => (edge.kind ?? edge.sourceHandle) === "success")
      .map((edge) => [edge.source, edge.target]),
  );
  const connectedFailure = new Map(
    edges.value
      .filter((edge) => (edge.kind ?? edge.sourceHandle) === "failure")
      .map((edge) => [edge.source, edge.target]),
  );
  const connectedTrue = new Map(
    edges.value
      .filter((edge) => edge.sourceHandle === "true")
      .map((edge) => [edge.source, edge.target]),
  );
  const connectedFalse = new Map(
    edges.value
      .filter((edge) => edge.sourceHandle === "false")
      .map((edge) => [edge.source, edge.target]),
  );
  const next = new Map(
    runtimeOrder.map((node) => [node.id, connectedNext.get(node.id) ?? null]),
  );
  const runtimeNodes = runtimeOrder.map((node) => {
    const nodeConfig = configFor(node);
    switch (node.data.block.type) {
      case "load-context":
        return {
          id: node.id,
          type: "load-context",
          version: 1,
          config: nodeConfig,
          onSuccess: next.get(node.id),
          ...(connectedFailure.get(node.id)
            ? { onFailure: connectedFailure.get(node.id) }
            : {}),
          inputs: node.data.inputs ?? {},
        };
      case "ai-chat":
        return {
          id: node.id,
          type: "ai-chat",
          version: 1,
          config: {
            providerRouteId: nodeConfig.providerRouteId,
            systemPrompt: nodeConfig.systemPrompt ?? "",
            promptTemplate:
              nodeConfig.promptTemplate ?? "请根据聊天上下文回答当前消息。",
            includeLoadedContext: true,
            timeoutMs: nodeConfig.timeoutMs ?? 60000,
            maxOutputTokens: nodeConfig.maxOutputTokens ?? 1024,
            maxOutputCharacters: nodeConfig.maxOutputCharacters ?? 4000,
            temperature: nodeConfig.temperature ?? null,
            outputFormat: nodeConfig.outputFormat ?? "text",
            outputVariable: nodeConfig.outputVariable ?? "aiReply",
          },
          onSuccess: next.get(node.id),
          ...(connectedFailure.get(node.id)
            ? { onFailure: connectedFailure.get(node.id) }
            : {}),
          inputs: node.data.inputs ?? {},
        };
      case "reply":
        return {
          id: node.id,
          type: "reply",
          version: 1,
          config: {
            text: nodeConfig.text || "{{variables.aiReply}}",
            replyToSourceMessage: nodeConfig.replyToSourceMessage ?? false,
            retry: nodeConfig.retry ?? { maxAttempts: 2, initialDelayMs: 250 },
          },
          onSuccess: next.get(node.id),
          ...(connectedFailure.get(node.id)
            ? { onFailure: connectedFailure.get(node.id) }
            : {}),
          inputs: node.data.inputs ?? {},
        };
      case "end":
        return {
          id: node.id,
          type: "end",
          version: 1,
          config: { result: nodeConfig.result || "succeeded" },
        };
      default:
        if (node.data.block.type === "condition") {
          return {
            id: node.id,
            type: "condition",
            version: 1,
            config: nodeConfig,
            onTrue: connectedTrue.get(node.id),
            onFalse: connectedFalse.get(node.id),
          };
        }
        return {
          id: node.id,
          type: node.data.block.type,
          version: 1,
          config: nodeConfig,
          onSuccess: next.get(node.id),
          ...(connectedFailure.get(node.id)
            ? { onFailure: connectedFailure.get(node.id) }
            : {}),
          inputs: node.data.inputs ?? {},
        };
    }
  });
  for (const runtimeNode of runtimeNodes) {
    if (runtimeNode.type === "condition") {
      runtimeNode.onTrue = connectedTrue.get(runtimeNode.id);
      runtimeNode.onFalse = connectedFalse.get(runtimeNode.id);
    }
  }
  const definition = {
    schemaVersion: "1",
    name: name.value || "New workflow",
    startNodeId: orderedNodes[0]?.id ?? "",
    maxSteps: 64,
    maxExecutionMs: 60000,
    nodes: runtimeNodes,
  };
  if (props.definition) emit("version", name.value, definition);
  else emit("create", name.value, definition);
}
function configFor(node: any) {
  return node.id === selected.value?.id
    ? config.value
    : (node.data.config ?? {});
}
function connect(connection: Connection) {
  const source = nodes.value.find((node) => node.id === connection.source);
  const target = nodes.value.find((node) => node.id === connection.target);
  if (
    source &&
    target &&
    connection.sourceHandle?.startsWith("output:") &&
    connection.targetHandle?.startsWith("input:")
  ) {
    const port = connection.targetHandle.slice("input:".length);
    const output = connection.sourceHandle.slice("output:".length);
    target.data.inputs = {
      ...(target.data.inputs ?? {}),
      [port]: { kind: "output", blockId: source.id, port: output },
    };
  }
  edges.value.push({
    ...connection,
    kind:
      connection.sourceHandle === "failure"
        ? "failure"
        : connection.sourceHandle === "true" ||
            connection.sourceHandle === "false"
          ? "branch"
          : connection.sourceHandle?.startsWith("output:")
            ? "data"
            : "success",
    id: `${connection.source}-${connection.target}-${Date.now()}`,
  });
}
watch(
  config,
  (value) => {
    if (selected.value) selected.value.data.config = { ...value };
  },
  { deep: true },
);
</script>
<template>
  <div class="workflow-editor">
    <aside class="action-palette">
      <h3>动作块</h3>
      <section v-for="(items, category) in grouped" :key="category">
        <h4>{{ category }}</h4>
        <button
          v-for="block in items"
          :key="`${block.type}@${block.version}`"
          draggable="true"
          @dragstart="dragStart($event, block)"
          @click="addBlock(block)"
        >
          {{ block.name }}
        </button>
      </section>
    </aside>
    <div class="workflow-canvas" @dragover.prevent @drop="drop">
      <VueFlow
        v-model:nodes="nodes"
        v-model:edges="edges"
        fit-view-on-init
        @connect="connect"
        @node-click="({ node }) => selectNode(node)"
      >
        <template #node-action="{ data }">
          <div class="action-node">
            <Handle id="control" type="target" :position="Position.Left" />
            <strong>{{ data.label }}</strong>
            <small class="node-hint">拖端口连接下一动作</small>
            <div
              v-for="(input, index) in data.block.inputs"
              :key="`in-${input.name}`"
              class="port-label input-port"
              :style="{ top: `${38 + Number(index) * 14}%` }"
            >
              <Handle
                :id="`input:${input.name}`"
                type="target"
                :position="Position.Left"
              />{{ input.label }}
            </div>
            <small
              v-for="(output, index) in data.block.outputs"
              :key="output.name"
              class="port-label output-port"
              :style="{ top: `${38 + Number(index) * 14}%` }"
            >
              <Handle
                :id="`output:${output.name}`"
                type="source"
                :position="Position.Right"
              />{{ output.label }}
            </small>
            <template v-if="data.block.branches?.length">
              <small
                v-for="(branch, index) in data.block.branches"
                :key="branch.name"
                class="port-label branch-port"
                :style="{ top: `${68 + Number(index) * 14}%` }"
              >
                <Handle
                  :id="branch.name === 'onTrue' ? 'true' : 'false'"
                  type="source"
                  :position="Position.Right"
                />{{ branch.label }}
              </small>
            </template>
            <template v-else>
              <small class="port-label control-port success-port"
                ><Handle
                  id="success"
                  type="source"
                  :position="Position.Right"
                />成功</small
              >
              <small
                v-if="
                  ['load-context', 'ai-chat', 'reply'].includes(data.block.type)
                "
                class="port-label control-port failure-port"
                ><Handle
                  id="failure"
                  type="source"
                  :position="Position.Right"
                />失败</small
              >
            </template>
          </div>
        </template>
      </VueFlow>
    </div>
    <aside class="node-inspector">
      <label>工作流名称<input v-model="name" maxlength="120" /></label
      ><template v-if="selected"
        ><h3>{{ selected.data.label }}</h3>
        <p class="node-description">{{ selected.data.block.description }}</p>
        <label v-for="item in selected.data.block.config" :key="item.name"
          ><span>{{ item.label }}</span
          ><select v-if="item.type === 'select'" v-model="config[item.name]">
            <option
              v-for="option in item.options ?? []"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option></select
          ><input
            v-else-if="item.type !== 'boolean'"
            v-model="config[item.name]"
            :type="item.type === 'number' ? 'number' : 'text'" /><input
            v-else
            v-model="config[item.name]"
            type="checkbox"
        /></label>
        <button class="button danger" type="button" @click="removeSelected">
          删除动作块
        </button>
      </template>
      <p v-else class="editor-empty-hint">
        从左侧点击或拖入动作块，然后用端口连接执行顺序和数据引用。
      </p>
      ><button class="button primary" type="button" @click="save">
        保存并生效
      </button>
    </aside>
  </div>
</template>
<style scoped>
.workflow-editor {
  display: grid;
  grid-template-columns: 190px minmax(420px, 1fr) 260px;
  min-height: 560px;
  border: 1px solid var(--line, #d9dee8);
  border-radius: 12px;
  overflow: hidden;
}
.action-palette,
.node-inspector {
  padding: 16px;
  background: var(--surface, #fff);
  overflow: auto;
}
.action-palette section {
  margin: 12px 0;
}
.action-palette button {
  display: block;
  width: 100%;
  margin: 5px 0;
  padding: 8px;
  text-align: left;
}
.workflow-canvas {
  min-height: 560px;
  background: #f7f9fc;
}
.node-inspector label {
  display: block;
  margin: 12px 0;
}
.node-inspector input,
.node-inspector select {
  display: block;
  width: 100%;
  margin-top: 5px;
}
.action-node {
  position: relative;
  min-width: 150px;
  padding: 12px;
  border: 1px solid #94a3b8;
  border-radius: 9px;
  background: white;
  box-shadow: 0 4px 12px #0f172a18;
}
.node-hint {
  display: block;
  margin-top: 5px;
  color: #94a3b8;
  font-size: 9px;
}
.control-port {
  right: 8px;
}
.success-port {
  top: 78%;
}
.failure-port {
  top: 90%;
}
.branch-port {
  right: 8px;
}
.node-description {
  margin: 4px 0 14px;
  color: #64748b;
  font-size: 11px;
  line-height: 1.5;
}
.editor-empty-hint {
  color: #64748b;
  font-size: 12px;
  line-height: 1.6;
}
.action-node small {
  display: block;
  color: #64748b;
  margin-top: 4px;
}
.port-label {
  position: absolute;
  font-size: 10px;
  color: #64748b;
  white-space: nowrap;
}
.input-port {
  left: 8px;
  transform: translateY(-50%);
}
.output-port {
  right: 8px;
  transform: translateY(-50%);
}
</style>
