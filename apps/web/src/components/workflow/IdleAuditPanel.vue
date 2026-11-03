<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { apiRequest, errorMessage } from "../../services/api";
import IdleWorkflowPreview from "./IdleWorkflowPreview.vue";
interface Workflow {
  id: string;
  name: string;
  publishedVersion: number | null;
}
const workflows = ref<Workflow[]>([]),
  selected = ref(""),
  error = ref(""),
  busy = ref(false);
const current = computed(() =>
  workflows.value.find((w) => w.id === selected.value),
);
let generation = 0;
async function load() {
  const ticket = ++generation;
  busy.value = true;
  error.value = "";
  try {
    const items = await apiRequest<Workflow[]>("/api/v1/workflows");
    if (ticket !== generation) return;
    workflows.value = items;
    if (!items.some((w) => w.id === selected.value))
      selected.value = items[0]?.id ?? "";
  } catch (e) {
    if (ticket === generation) error.value = errorMessage(e);
  } finally {
    if (ticket === generation) busy.value = false;
  }
}
onMounted(() => {
  void load();
});
onBeforeUnmount(() => {
  generation++;
});
</script>
<template>
  <section class="admin-panel">
    <p v-if="error" role="alert">
      {{ error }} <button class="button secondary" @click="load">重试</button>
    </p>
    <IdleWorkflowPreview
      v-if="current"
      :workflow-id="current.id"
      :version="current.publishedVersion"
    >
      <template #workflow-filter
        ><label
          >工作流<select v-model="selected">
            <option
              v-for="workflow in workflows"
              :key="workflow.id"
              :value="workflow.id"
            >
              {{ workflow.name }}
            </option>
          </select></label
        ></template
      >
    </IdleWorkflowPreview>
    <div v-else>
      <h2>空闲主动交流</h2>
      <p>{{ busy ? "正在加载工作流…" : "暂无可查看的工作流。" }}</p>
    </div>
  </section>
</template>
