<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import ToggleSwitch from "../ToggleSwitch.vue";
import { apiRequest } from "../../services/api";
import type { ImageReply } from "../../../../../modules/generated-images/image-policy";
const props = defineProps<{
  modelValue?: ImageReply;
  pluginIds: string[];
  outputFormat: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: ImageReply] }>();
interface Target {
  pluginId: string;
  pluginName: string;
  server: string;
}
const targets = ref<Target[]>([]),
  loading = ref(true),
  error = ref("");
let active = true;
onBeforeUnmount(() => {
  active = false;
});
onMounted(async () => {
  try {
    const value = await apiRequest<Target[]>(
      "/api/v1/plugins/image-export-targets",
    );
    if (active) targets.value = value;
  } catch {
    if (active) error.value = "图片导出能力读取失败，请重新打开节点重试。";
  } finally {
    if (active) loading.value = false;
  }
});
const candidates = computed(() =>
  targets.value.filter((t) => props.pluginIds.includes(t.pluginId)),
);
const selected = computed(() =>
  candidates.value.find(
    (t) =>
      t.pluginId === props.modelValue?.pluginId &&
      t.server === props.modelValue?.server,
  ),
);
function update(change: Partial<ImageReply>) {
  emit("update:modelValue", {
    enabled: false,
    pluginId: "",
    server: "",
    ...props.modelValue,
    ...change,
  });
}
const enabled = computed({
  get: () => props.modelValue?.enabled ?? false,
  set: (value: boolean) => {
    const target =
      !props.modelValue?.pluginId && candidates.value.length === 1
        ? candidates.value[0]
        : undefined;
    update({
      enabled: value,
      ...(target ? { pluginId: target.pluginId, server: target.server } : {}),
    });
  },
});
function choose(value: string) {
  const target = candidates.value.find(
    (t) => JSON.stringify([t.pluginId, t.server]) === value,
  );
  if (target) update({ pluginId: target.pluginId, server: target.server });
}
</script>
<template>
  <section class="image-reply-settings">
    <div class="image-reply-heading">
      <h4>生成图片回复</h4>
      <ToggleSwitch
        v-model="enabled"
        label="生成图片回复"
        :disabled="
          loading || outputFormat !== 'text' || (!candidates.length && !enabled)
        "
      />
    </div>
    <p>允许将本次沙箱中的一张 PNG 发到当前聊天，可配说明文字。看图检查可选。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="loading">正在读取已批准的图片导出能力…</p>
    <p v-else-if="outputFormat !== 'text'">将输出格式设为“文本”后可启用。</p>
    <p v-else-if="!candidates.length">
      请先升级沙箱插件和运行镜像，发现并授权工具，再允许本节点使用该插件。
    </p>
    <label v-if="enabled"
      >图片输出沙箱<select
        :value="
          selected ? JSON.stringify([selected.pluginId, selected.server]) : ''
        "
        @change="choose(($event.target as HTMLSelectElement).value)"
      >
        <option value="" disabled>请选择沙箱</option>
        <option
          v-for="target in candidates"
          :key="JSON.stringify([target.pluginId, target.server])"
          :value="JSON.stringify([target.pluginId, target.server])"
        >
          {{ target.pluginName }} · {{ target.server }}
        </option>
      </select></label
    >
    <p v-if="enabled">
      将“生成图片”和“文本输出”连接到同一个发送节点。若启用附件处理，选择相同沙箱；首版不支持引用回复或调度触发。
    </p>
  </section>
</template>
<style scoped>
.image-reply-settings {
  display: grid;
  gap: 10px;
  border-top: 1px solid var(--bubblepilot-border, #dbe3ec);
  padding-top: 16px;
  min-width: 0;
}
.image-reply-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
h4,
p {
  margin: 0;
}
p {
  font-size: 13px;
  color: var(--bubblepilot-muted, #64748b);
  overflow-wrap: anywhere;
}
label {
  display: grid;
  gap: 6px;
}
select {
  min-width: 0;
  width: 100%;
  max-width: 100%;
}
</style>
