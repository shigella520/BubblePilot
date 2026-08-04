<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { VueFlow, Handle, Position, type Connection, type Edge, type Node } from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";

interface Block { type: string; version: number; name: string; description: string; category: string; inputs: Array<{name:string;label:string;type:string;required?:boolean}>; outputs: Array<{name:string;label:string;type:string}>; config: Array<{name:string;label:string;type:string;required?:boolean;options?:Array<{value:string;label:string}>}>; branches?: Array<{name:string;label:string}> }
const props = defineProps<{ blocks: Block[]; workflowName?: string; definition?: any }>();
const emit = defineEmits<{ (e:"create", name:string, definition:any):void; (e:"version", name:string, definition:any):void }>();
const name = ref(props.workflowName ?? "");
const nodes = ref<any[]>([]); const edges = ref<any[]>([]); const selected = ref<any | null>(null); const config = ref<Record<string, any>>({});
const grouped = computed(() => props.blocks.reduce((map, block) => { (map[block.category] ??= []).push(block); return map; }, {} as Record<string, Block[]>));
function addBlock(block: Block) { const id = `${block.type}-${Date.now()}`; nodes.value.push({ id, type: "action", position: { x: 80 + nodes.value.length * 30, y: 80 + nodes.value.length * 30 }, data: { label: block.name, block } }); selected.value = nodes.value[nodes.value.length - 1]; config.value = {}; }
function dragStart(event: DragEvent, block: Block) { event.dataTransfer?.setData("application/x-action-block", JSON.stringify(block)); }
function drop(event: DragEvent) { const raw = event.dataTransfer?.getData("application/x-action-block"); if (!raw) return; addBlock(JSON.parse(raw) as Block); }
function selectNode(node: any) { selected.value = node; config.value = { ...(node.data.config ?? {}) }; }
function save() { const definition = { schemaVersion: "1", name: name.value || "New workflow", startNodeId: nodes.value[0]?.id ?? "", maxSteps: 64, maxExecutionMs: 60000, nodes: nodes.value.map((node) => ({ id: node.id, type: node.data.block.type, version: node.data.block.version, position: node.position, config: configFor(node), inputs: node.data.inputs ?? {} })), edges: edges.value.map((edge) => ({ id: edge.id, source: edge.source, sourcePort: edge.sourceHandle ?? "success", target: edge.target, targetPort: edge.targetHandle ?? "success", kind: "data" })) }; props.definition ? emit("version", name.value, definition) : emit("create", name.value, definition); }
function configFor(node: Node) { return node.id === selected.value?.id ? config.value : (node.data.config ?? {}); }
function connect(connection: Connection) { edges.value.push({ ...connection, id: `${connection.source}-${connection.target}-${Date.now()}` }); }
watch(config, (value) => { if (selected.value) selected.value.data.config = { ...value }; }, { deep: true });
</script>
<template>
  <div class="workflow-editor">
    <aside class="action-palette"><h3>动作块</h3><section v-for="(items, category) in grouped" :key="category"><h4>{{ category }}</h4><button v-for="block in items" :key="`${block.type}@${block.version}`" draggable="true" @dragstart="dragStart($event, block)" @click="addBlock(block)">{{ block.name }}</button></section></aside>
    <div class="workflow-canvas" @dragover.prevent @drop="drop"><VueFlow v-model:nodes="nodes" v-model:edges="edges" fit-view-on-init @connect="connect" @node-click="({ node }) => selectNode(node)"><template #node-action="{ data }"><div class="action-node"><Handle type="target" :position="Position.Left" /><strong>{{ data.label }}</strong><small v-for="output in data.block.outputs" :key="output.name">{{ output.label }}</small><Handle type="source" :position="Position.Right" /></div></template></VueFlow></div>
    <aside class="node-inspector"><label>工作流名称<input v-model="name" maxlength="120" /></label><template v-if="selected"><h3>{{ selected.data.label }}</h3><label v-for="item in selected.data.block.config" :key="item.name"><span>{{ item.label }}</span><select v-if="item.type === 'select'" v-model="config[item.name]"><option v-for="option in item.options ?? []" :key="option.value" :value="option.value">{{ option.label }}</option></select><input v-else-if="item.type !== 'boolean'" v-model="config[item.name]" :type="item.type === 'number' ? 'number' : 'text'" /><input v-else v-model="config[item.name]" type="checkbox" /></label></template><button class="button primary" type="button" @click="save">保存候选版本</button></aside>
  </div>
</template>
<style scoped>
.workflow-editor{display:grid;grid-template-columns:190px minmax(420px,1fr) 260px;min-height:560px;border:1px solid var(--line,#d9dee8);border-radius:12px;overflow:hidden}.action-palette,.node-inspector{padding:16px;background:var(--surface,#fff);overflow:auto}.action-palette section{margin:12px 0}.action-palette button{display:block;width:100%;margin:5px 0;padding:8px;text-align:left}.workflow-canvas{min-height:560px;background:#f7f9fc}.node-inspector label{display:block;margin:12px 0}.node-inspector input,.node-inspector select{display:block;width:100%;margin-top:5px}.action-node{min-width:150px;padding:12px;border:1px solid #94a3b8;border-radius:9px;background:white;box-shadow:0 4px 12px #0f172a18}.action-node small{display:block;color:#64748b;margin-top:4px}
</style>
