<script setup lang="ts">
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unused-expressions, vue/no-unused-vars */
import { onBeforeUnmount, ref, watch } from "vue";
import { VueFlow, type Connection } from "@vue-flow/core";
import { MarkerType } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";
import dagre from "@dagrejs/dagre";
import WorkflowNode from "./WorkflowNode.vue";
import WorkflowEdge from "./WorkflowEdge.vue";
import NodeCreator from "./NodeCreator.vue";
import NodeInspector from "./NodeInspector.vue";
import "@vue-flow/core/dist/style.css";

interface Port { name: string; label: string; type: string; required?: boolean }
interface Block { type: string; version: number; name: string; description: string; category: string; inputs: Port[]; outputs: Port[]; config: any[]; branches?: Array<{ name: string; label: string }> }
const props = defineProps<{ blocks: Block[]; workflowName?: string; definition?: any }>();
const emit = defineEmits<{ (event: "create", name: string, definition: any): void; (event: "version", name: string, definition: any): void }>();
const name = ref(props.workflowName ?? "");
const nodes = ref<any[]>([]);
const edges = ref<any[]>([]);
const selected = ref<any | null>(null);
const config = ref<Record<string, any>>({});
const creatorOpen = ref(false);
const creatorPosition = ref({ x: 120, y: 120 });
const hydratedDefinition = ref("");
const copiedNode = ref<any | null>(null);
const history = ref<string[]>([]);
const future = ref<string[]>([]);

function blockFor(type: string): Block { return props.blocks.find((item) => item.type === type) ?? { type, version: 1, name: type, description: "未知动作", category: "", inputs: [], outputs: [], config: [] }; }
function defaultConfig(block: Block): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const item of block.config) values[item.name] = item.type === "boolean" ? false : item.type === "select" ? item.options?.[0]?.value ?? "" : item.name === "promptTemplate" ? "请根据聊天上下文回答当前消息。" : "";
  if (block.type === "load-context") Object.assign(values, { messageLimit: 10, characterLimit: 6000, includeFromMe: true });
  if (block.type === "ai-chat") Object.assign(values, { timeoutMs: 60000, maxOutputTokens: 1024, maxOutputCharacters: 4000, temperature: null, outputVariable: "aiReply", includeLoadedContext: true });
  if (block.type === "reply") Object.assign(values, { text: "{{variables.aiReply}}", replyToSourceMessage: false, retry: { maxAttempts: 2, initialDelayMs: 250 } });
  if (block.type === "end") values.result = "succeeded";
  return values;
}
function snapshot() { return JSON.stringify({ nodes: nodes.value, edges: edges.value, name: name.value }); }
function recordHistory() { history.value.push(snapshot()); if (history.value.length > 50) history.value.shift(); future.value = []; }
function restore(raw: string) { const value = JSON.parse(raw); nodes.value = value.nodes; edges.value = value.edges; name.value = value.name; selected.value = null; config.value = {}; }
function undo() { const previous = history.value.pop(); if (!previous) return; future.value.push(snapshot()); restore(previous); }
function redo() { const next = future.value.pop(); if (!next) return; history.value.push(snapshot()); restore(next); }
function addBlock(block: Block, position = creatorPosition.value) {
  recordHistory();
  const id = `${block.type}-${Date.now()}`;
  const node = { id, type: "action", position: { x: position.x, y: position.y }, data: { label: block.name, block, config: defaultConfig(block), inputs: {} } };
  nodes.value.push(node); selected.value = node; config.value = { ...node.data.config }; creatorOpen.value = false;
}
function openCreator(position = { x: 180, y: 160 }) { creatorPosition.value = position; creatorOpen.value = true; }
function openCreatorAt(payload: any) {
  const event = payload?.event as MouseEvent | undefined;
  openCreator(event ? { x: event.offsetX, y: event.offsetY } : undefined);
}
function selectNode(node: any) { selected.value = node; config.value = { ...(node.data.config ?? {}) }; }
function updateInput(port: string, value: any) { if (!selected.value) return; recordHistory(); selected.value.data.inputs = { ...(selected.value.data.inputs ?? {}), [port]: value }; }
function removeSelected() { if (!selected.value) return; recordHistory(); const id = selected.value.id; nodes.value = nodes.value.filter((node) => node.id !== id); edges.value = edges.value.filter((edge) => edge.source !== id && edge.target !== id); selected.value = null; config.value = {}; }
function portType(node: any, handle: string | null | undefined): string { if (!handle) return "control"; if (handle === "control" || handle === "success" || handle === "failure" || handle === "true" || handle === "false") return "control"; const [mode, name] = handle.split(":"); const port = mode === "input" ? node.data.block.inputs.find((item: Port) => item.name === name) : node.data.block.outputs.find((item: Port) => item.name === name); return port?.type ?? "control"; }
function hasPath(from: string, target: string, visited = new Set<string>()): boolean { if (from === target) return true; if (visited.has(from)) return false; visited.add(from); return edges.value.filter((edge) => edge.source === from && edge.kind !== "data").some((edge) => hasPath(edge.target, target, visited)); }
function isValidConnection(connection: Connection): boolean {
  if (!connection.source || !connection.target || connection.source === connection.target) return false;
  const source = nodes.value.find((node) => node.id === connection.source); const target = nodes.value.find((node) => node.id === connection.target);
  if (!source || !target || !connection.sourceHandle || !connection.targetHandle) return false;
  if (hasPath(connection.target, connection.source)) return false;
  const sourceType = portType(source, connection.sourceHandle); const targetType = portType(target, connection.targetHandle);
  if (connection.sourceHandle.startsWith("output:") && !connection.targetHandle.startsWith("input:")) return false;
  if (!connection.sourceHandle.startsWith("output:") && connection.targetHandle !== "control") return false;
  if (sourceType === targetType || sourceType === "control" || targetType === "string") return true;
  return false;
}
function connect(connection: Connection) {
  if (!isValidConnection(connection)) return;
  recordHistory();
  const source = nodes.value.find((node) => node.id === connection.source); const target = nodes.value.find((node) => node.id === connection.target);
  const data = connection.sourceHandle?.startsWith("output:");
  if (data && source && target && connection.targetHandle?.startsWith("input:") && connection.sourceHandle) { const input = connection.targetHandle.slice(6); const output = connection.sourceHandle.slice(7); target.data.inputs = { ...(target.data.inputs ?? {}), [input]: { kind: "output", blockId: source.id, port: output } }; }
  const kind = connection.sourceHandle === "failure" ? "failure" : connection.sourceHandle === "true" || connection.sourceHandle === "false" ? "branch" : data ? "data" : "success";
  edges.value = [...edges.value.filter((edge) => !(kind === "data" && edge.target === connection.target && edge.targetHandle === connection.targetHandle)), { ...connection, kind, type: "workflow" }];
}
function deleteEdge(id: string) { const edge = edges.value.find((item) => item.id === id); if (!edge) return; recordHistory(); edges.value = edges.value.filter((item) => item.id !== id); if (edge.kind === "data") { const target = nodes.value.find((node) => node.id === edge.target); const input = edge.targetHandle?.slice(6); if (target && input) { target.data.inputs = { ...(target.data.inputs ?? {}) }; delete target.data.inputs[input]; } } }
function tidy() {
  if (!nodes.value.length) return; recordHistory(); const graph = new dagre.graphlib.Graph(); graph.setGraph({ rankdir: "LR", nodesep: 70, ranksep: 130 }); graph.setDefaultEdgeLabel(() => ({})); nodes.value.forEach((node) => graph.setNode(node.id, { width: 230, height: 150 })); edges.value.filter((edge) => edge.kind !== "data").forEach((edge) => graph.setEdge(edge.source, edge.target)); dagre.layout(graph); nodes.value = nodes.value.map((node) => { const point = graph.node(node.id); return point ? { ...node, position: { x: point.x - 115, y: point.y - 75 } } : node; }); }
function configFor(node: any) { return node.id === selected.value?.id ? config.value : (node.data.config ?? {}); }
function toDefinition() {
  const next = new Map(edges.value.filter((edge) => edge.kind === "success").map((edge) => [edge.source, edge.target])); const failure = new Map(edges.value.filter((edge) => edge.kind === "failure").map((edge) => [edge.source, edge.target])); const onTrue = new Map(edges.value.filter((edge) => edge.sourceHandle === "true").map((edge) => [edge.source, edge.target])); const onFalse = new Map(edges.value.filter((edge) => edge.sourceHandle === "false").map((edge) => [edge.source, edge.target]));
  const runtimeNodes = nodes.value.map((node) => { const common = { id: node.id, version: 1, config: configFor(node), inputs: node.data.inputs ?? {} }; if (node.data.block.type === "condition") return { ...common, type: "condition", ...(onTrue.get(node.id) ? { onTrue: onTrue.get(node.id) } : {}), ...(onFalse.get(node.id) ? { onFalse: onFalse.get(node.id) } : {}) }; if (node.data.block.type === "end") return { ...common, type: "end" }; return { ...common, type: node.data.block.type, ...(next.get(node.id) ? { onSuccess: next.get(node.id) } : {}), ...(failure.get(node.id) ? { onFailure: failure.get(node.id) } : {}) }; });
  return { schemaVersion: "1", name: name.value || "New workflow", startNodeId: nodes.value[0]?.id ?? "", maxSteps: 64, maxExecutionMs: 60000, nodes: runtimeNodes };
}
function save() { const definition = toDefinition(); if (props.definition) emit("version", name.value, definition); else emit("create", name.value, definition); }
function hydrate(definition: any) { if (!definition || hydratedDefinition.value === JSON.stringify(definition)) return; const sourceNodes = Array.isArray(definition.nodes) ? definition.nodes : []; nodes.value = sourceNodes.map((item: any, index: number) => { const block = blockFor(item.type); return { id: item.id, type: "action", position: item.position ?? { x: 80 + index * 260, y: 100 }, data: { label: block.name, block, config: { ...(item.config ?? {}) }, inputs: item.inputs ?? {} } }; }); const result: any[] = []; for (const item of sourceNodes) { for (const [kind, target] of [["success", item.onSuccess], ["failure", item.onFailure], ["true", item.onTrue], ["false", item.onFalse]] as const) if (typeof target === "string") result.push({ id: `${item.id}-${kind}-${target}`, source: item.id, sourceHandle: kind, target, targetHandle: "control", kind, type: "workflow" }); for (const [port, reference] of Object.entries(item.inputs ?? {})) if ((reference as any)?.kind === "output") result.push({ id: `${(reference as any).blockId}-${item.id}-${port}`, source: (reference as any).blockId, sourceHandle: `output:${(reference as any).port}`, target: item.id, targetHandle: `input:${port}`, kind: "data", type: "workflow" }); } edges.value = result; hydratedDefinition.value = JSON.stringify(definition); }
watch(() => props.workflowName, (value) => { if (value) name.value = value; }); watch(() => props.definition, (definition) => { if (definition === undefined) { nodes.value = []; edges.value = []; selected.value = null; hydratedDefinition.value = ""; return; } hydrate(definition); }, { immediate: true, deep: true }); watch(config, (value) => { if (selected.value) selected.value.data.config = { ...value }; }, { deep: true });
function onKeydown(event: KeyboardEvent) { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && selected.value) copiedNode.value = JSON.parse(JSON.stringify(selected.value)); if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v" && copiedNode.value) addBlock(copiedNode.value.data.block, { x: copiedNode.value.position.x + 40, y: copiedNode.value.position.y + 40 }); }
window.addEventListener("keydown", onKeydown); onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="workflow-editor-v2">
    <div class="workflow-toolbar"><button class="button secondary" type="button" @click="openCreator()">＋ 添加动作</button><button class="button secondary" type="button" @click="tidy">自动整理</button><button class="button secondary" type="button" :disabled="!history.length" @click="undo">撤销</button><button class="button secondary" type="button" :disabled="!future.length" @click="redo">重做</button><label class="workflow-name-field">工作流名称<input v-model="name" maxlength="120" /></label><button class="button primary" type="button" @click="save">保存并生效</button></div>
    <div class="workflow-stage">
      <NodeCreator :blocks="props.blocks" :open="creatorOpen" @close="creatorOpen = false" @select="(block) => addBlock(block)" />
      <VueFlow v-model:nodes="nodes" v-model:edges="edges" class="workflow-flow" fit-view-on-init :connection-line-options="{ markerEnd: MarkerType.ArrowClosed }" :is-valid-connection="isValidConnection" @connect="connect" @pane-click="openCreatorAt" @node-click="({ node }) => selectNode(node)" @edge-click="({ edge }) => deleteEdge(edge.id)">
        <template #node-action="{ data, id }"><WorkflowNode :data="data" @add="() => openCreator()" /></template>
        <template #edge-workflow="edgeProps"><WorkflowEdge v-bind="edgeProps" @delete="deleteEdge" /></template>
        <Background pattern-color="#cbd5e1" :gap="24" /><Controls /><MiniMap pannable zoomable />
        <svg><defs><marker id="workflow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" /></marker></defs></svg>
      </VueFlow>
      <NodeInspector :node="selected" :config="config" :references="nodes.filter((item) => item.id !== selected?.id).flatMap((item) => item.data.block.outputs.map((output: any) => `output:${item.id}:${output.name}`))" @close="selected = null" @remove="removeSelected" @update:input="updateInput" @update:name="(value) => { if (selected) selected.data.label = value; }" />
    </div>
  </div>
</template>
