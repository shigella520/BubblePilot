<script setup lang="ts">
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, vue/no-mutating-props */
const props = defineProps<{
  node: any | null;
  config: Record<string, any>;
  references?: Array<string | { value: string; label: string }>;
}>();
const emit = defineEmits<{
  (event: "update:name", value: string): void;
  (event: "update:input", port: string, value: any): void;
  (event: "remove"): void;
  (event: "close"): void;
}>();
function referenceValue(port: string): string {
  const value = props.node?.data?.inputs?.[port];
  if (!value) return "literal";
  if (value.kind === "path") return `path:${value.path}`;
  if (value.kind === "output") return `output:${value.blockId}:${value.port}`;
  return "literal";
}
function updateReference(port: string, value: string) {
  if (value === "literal")
    emit("update:input", port, { kind: "literal", value: "" });
  else if (value.startsWith("path:"))
    emit("update:input", port, { kind: "path", path: value.slice(5) });
  else if (value.startsWith("output:")) {
    const [, blockId, outputPort] = value.split(":");
    emit("update:input", port, { kind: "output", blockId, port: outputPort });
  }
}
function jsonValue(name: string): string {
  const value = props.config[name];
  return Array.isArray(value) ? value.join("\n") : JSON.stringify(value ?? []);
}
function updateJson(name: string, raw: string) {
  try {
    const parsed = JSON.parse(raw);
    props.config[name] = parsed;
  } catch {
    props.config[name] = raw
      .split(/\r?\n|,/u)
      .map((item) => item.trim())
      .filter(Boolean);
  }
}
function firstArrayValue(name: string): string {
  const value = props.config[name];
  return Array.isArray(value) && value.length > 0 ? String(value[0]) : "";
}
function updateSingleArray(name: string, value: string) {
  props.config[name] = value ? [value] : [];
}
function referenceOptionValue(reference: string | { value: string }): string {
  return typeof reference === "string" ? reference : reference.value;
}
function referenceOptionLabel(
  reference: string | { value: string; label: string },
): string {
  return typeof reference === "string" ? reference : reference.label;
}
</script>
<template>
  <aside v-if="node" class="workflow-node-inspector">
    <div class="workflow-inspector-head">
      <div>
        <small>动作块</small>
        <h3>{{ node.data.label }}</h3>
      </div>
      <button type="button" @click="emit('close')">×</button>
    </div>
    <label
      >节点名称<input
        :value="node.data.label"
        maxlength="80"
        @input="emit('update:name', ($event.target as HTMLInputElement).value)"
    /></label>
    <p class="workflow-inspector-description">
      {{ node.data.block.description }}
    </p>
    <div v-if="node.data.block.inputs.length" class="workflow-inspector-inputs">
      <strong>输入引用</strong
      ><label v-for="input in node.data.block.inputs" :key="input.name"
        ><span>{{ input.label }}</span
        ><select
          :value="referenceValue(input.name)"
          @change="
            updateReference(
              input.name,
              ($event.target as HTMLSelectElement).value,
            )
          "
        >
          <option value="literal">固定值（在动作配置中填写）</option>
          <option value="path:context.event.message.text">当前消息文本</option>
          <option value="path:context.history.messages">聊天历史消息</option>
          <option value="path:context.history.count">历史消息数量</option>
          <option
            v-for="reference in props.references ?? []"
            :key="referenceOptionValue(reference)"
            :value="referenceOptionValue(reference)"
          >
            {{ referenceOptionLabel(reference) }}
          </option>
        </select></label
      >
    </div>
    <div
      v-for="item in node.data.block.config"
      :key="item.name"
      class="workflow-inspector-field"
    >
      <label
        ><span>{{ item.label }}</span
        ><select
          v-if="item.type === 'select'"
          v-model="props.config[item.name]"
        >
          <option
            v-for="option in item.options ?? []"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option></select
        ><select
          v-else-if="item.type === 'select-array'"
          :value="firstArrayValue(item.name)"
          @change="
            updateSingleArray(
              item.name,
              ($event.target as HTMLSelectElement).value,
            )
          "
        >
          <option value="">{{ item.emptyLabel ?? "不限" }}</option>
          <option
            v-for="option in item.options ?? []"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option></select
        ><textarea
          v-else-if="item.type === 'json'"
          :value="jsonValue(item.name)"
          rows="3"
          @input="
            updateJson(item.name, ($event.target as HTMLTextAreaElement).value)
          "
        ></textarea
        ><input
          v-else-if="item.type !== 'boolean'"
          v-model="props.config[item.name]"
          :type="item.type === 'number' ? 'number' : 'text'" /><input
          v-else
          v-model="props.config[item.name]"
          type="checkbox"
      /></label>
      <small>{{ item.description }}</small>
    </div>
    <button class="button danger" type="button" @click="emit('remove')">
      删除动作块
    </button>
  </aside>
</template>
