<script setup lang="ts">
import { computed, ref } from "vue";
interface Tool {
  server: string;
  hash: string;
  definition: { name: string; description: string };
}
const props = defineProps<{
  tools: Tool[];
  modelValue: string[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();
const query = ref("");
const scope = ref("all");
const keyOf = (tool: Tool) =>
  `${tool.server}/${tool.definition.name}#${tool.hash}`;
const selected = computed(() => new Set(props.modelValue));
const selectedCount = computed(
  () => props.tools.filter((tool) => selected.value.has(keyOf(tool))).length,
);
const visible = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  return props.tools.filter((tool) => {
    const checked = selected.value.has(keyOf(tool));
    return (
      (scope.value === "all" ||
        (scope.value === "selected" ? checked : !checked)) &&
      `${tool.server} ${tool.definition.name} ${tool.definition.description}`
        .toLocaleLowerCase()
        .includes(term)
    );
  });
});
function toggle(tool: Tool, event: Event) {
  const next = new Set(props.modelValue);
  if ((event.target as HTMLInputElement).checked) next.add(keyOf(tool));
  else next.delete(keyOf(tool));
  emit("update:modelValue", [...next]);
}
</script>

<template>
  <section class="tool-picker" aria-label="工具授权">
    <header class="tool-picker-heading">
      <div>
        <h3>工具授权</h3>
        <p>工具目录来自 MCP 服务，可能随服务更新。只勾选本工作流需要的能力。</p>
      </div>
      <span class="tool-count" role="status">
        已选 {{ selectedCount }} / {{ tools.length }}
      </span>
    </header>
    <div class="tool-filters">
      <input
        v-model="query"
        type="search"
        aria-label="搜索工具"
        placeholder="搜索工具名称、服务或描述"
        :disabled="disabled"
      />
      <select
        v-model="scope"
        aria-label="筛选工具授权状态"
        :disabled="disabled"
      >
        <option value="all">全部工具</option>
        <option value="selected">已选择</option>
        <option value="unselected">未选择</option>
      </select>
      <button
        type="button"
        :disabled="disabled || !modelValue.length"
        @click="emit('update:modelValue', [])"
      >
        清空选择
      </button>
    </div>
    <p class="tool-help">
      勾选仅修改当前表单，保存后才生效。筛选不会改变选择；服务端的只读注解不代表权限保证。
    </p>
    <div class="tool-list">
      <article
        v-for="tool in visible"
        :key="keyOf(tool)"
        class="tool-item"
        :class="{ 'is-selected': selected.has(keyOf(tool)) }"
      >
        <label class="tool-toggle">
          <input
            type="checkbox"
            :checked="selected.has(keyOf(tool))"
            :disabled="disabled"
            :aria-label="`${tool.server} / ${tool.definition.name}`"
            @change="toggle(tool, $event)"
          />
          <span class="tool-title">
            <strong>{{ tool.definition.name }}</strong>
            <span class="tool-server">{{ tool.server }}</span>
          </span>
          <span class="tool-selection">{{
            selected.has(keyOf(tool)) ? "已选择" : "未选择"
          }}</span>
        </label>
        <details class="tool-description">
          <summary>查看完整描述</summary>
          <p>{{ tool.definition.description || "服务未提供描述。" }}</p>
        </details>
      </article>
      <p v-if="!visible.length" class="tool-empty">
        没有符合条件的工具，请调整搜索或筛选。
      </p>
    </div>
    <p class="tool-help">
      显示 {{ visible.length }} 项 ·
      保存前请审阅所选工具的用途、数据访问及副作用。
    </p>
  </section>
</template>

<style scoped>
.tool-picker {
  min-width: 0;
}
.tool-picker-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}
.tool-picker-heading h3 {
  margin: 0 0 8px;
}
.tool-picker-heading p,
.tool-help {
  margin: 0;
  color: var(--bubblepilot-muted, #64748b);
  font-size: 13px;
  line-height: 1.6;
  font-weight: 400;
}
.tool-count {
  flex-shrink: 0;
  padding: 5px 10px;
  border-radius: 20px;
  background: rgba(10, 132, 255, 0.08);
  color: #2563a5;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.tool-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
}
.tool-filters input,
.tool-filters select,
.tool-filters button {
  border: 1px solid #cbd5e1;
  border-radius: 9px;
  padding: 9px 12px;
  background: var(--surface, #fff);
  color: inherit;
  font: inherit;
  min-width: 0;
}
.tool-filters select,
.tool-filters button {
  width: auto;
}
.tool-filters input {
  width: auto;
  flex: 1 1 240px;
}
.tool-filters button {
  cursor: pointer;
}
.tool-list {
  display: grid;
  gap: 10px;
  margin: 14px 0;
}
.tool-item {
  border: 1px solid var(--border-color, #dce2ea);
  border-radius: 12px;
  padding: 14px;
  min-width: 0;
  background: var(--surface, #fff);
}
.tool-item.is-selected {
  border-color: #9fbeda;
  background: rgba(10, 132, 255, 0.025);
}
.tool-item .tool-toggle {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
  cursor: pointer;
  margin: 0;
}
.tool-toggle input {
  width: 18px;
  height: 18px;
  margin: 2px 0 0;
  accent-color: #337fb9;
}
.tool-title {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.tool-title strong {
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.tool-server,
.tool-selection {
  font-size: 12px;
  color: var(--bubblepilot-muted, #64748b);
  font-weight: 400;
}
.tool-description {
  margin: 10px 0 0 32px;
}
.tool-description summary {
  cursor: pointer;
  color: #426b8c;
  font-size: 13px;
  width: fit-content;
}
.tool-description p {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.7;
  font-weight: 400;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--bubblepilot-muted, #64748b);
}
.tool-empty {
  padding: 20px;
  text-align: center;
  color: var(--bubblepilot-muted, #64748b);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
input:focus-visible,
select:focus-visible,
button:focus-visible,
summary:focus-visible {
  outline: 2px solid #337fb9;
  outline-offset: 3px;
}
@media (max-width: 640px) {
  .tool-picker-heading {
    flex-wrap: wrap;
  }
  .tool-filters input {
    flex-basis: 100%;
  }
  .tool-filters select {
    flex: 1;
  }
  .tool-item {
    padding: 12px;
  }
  .tool-toggle {
    column-gap: 8px;
  }
  .tool-selection {
    display: none;
  }
  .tool-description {
    margin-left: 32px;
  }
}
</style>
