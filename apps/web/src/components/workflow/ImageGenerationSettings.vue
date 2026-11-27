<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import ToggleSwitch from "../ToggleSwitch.vue";
import { apiRequest } from "../../services/api";
import type { ImageGeneration } from "../../../../../modules/generated-images/image-policy";
const props = defineProps<{
  modelValue?: ImageGeneration;
  pluginIds: string[];
  outputFormat: string;
  sandboxTargets: Array<{ pluginId: string; server: string } | undefined>;
}>();
const emit = defineEmits<{ "update:modelValue": [value: ImageGeneration] }>();
interface Target {
  pluginId: string;
  pluginName: string;
  server: string;
  kind?: "sandbox" | "generator";
  workspacePrefix?: string;
  mimeTypes?: string[];
}
const exportTargets = ref<Target[]>([]),
  attachmentTargets = ref<Target[]>([]),
  loading = ref(true),
  error = ref("");
let active = true;
onBeforeUnmount(() => {
  active = false;
});
onMounted(async () => {
  try {
    const [exports, attachments] = await Promise.all([
      apiRequest<Target[]>("/api/v1/plugins/image-export-targets"),
      apiRequest<Target[]>("/api/v1/plugins/attachment-targets"),
    ]);
    if (!active) return;
    exportTargets.value = exports;
    attachmentTargets.value = attachments;
  } catch {
    if (active) error.value = "生图插件能力读取失败，请重新打开节点重试。";
  } finally {
    if (active) loading.value = false;
  }
});
const key = (t: { pluginId: string; server: string }) =>
  JSON.stringify([t.pluginId, t.server]);
// A generator must offer both image import and PNG export on the same server.
const candidates = computed(() =>
  exportTargets.value.filter(
    (t) =>
      t.kind === "generator" &&
      props.pluginIds.includes(t.pluginId) &&
      attachmentTargets.value.some(
        (a) => a.kind === "generator" && key(a) === key(t),
      ) &&
      !props.sandboxTargets.some((s) => s && key(s) === key(t)),
  ),
);
const selected = computed(() =>
  candidates.value.find(
    (t) =>
      t.pluginId === props.modelValue?.pluginId &&
      t.server === props.modelValue?.server,
  ),
);
const inputTypes = computed(() =>
  (
    attachmentTargets.value.find(
      (a) =>
        a.kind === "generator" &&
        selected.value &&
        key(a) === key(selected.value),
    )?.mimeTypes ?? []
  )
    .map((m) => m.replace("image/", "").toUpperCase())
    .join("、"),
);
function update(change: Partial<ImageGeneration>) {
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
  const target = candidates.value.find((t) => key(t) === value);
  if (target) update({ pluginId: target.pluginId, server: target.server });
}
</script>
<template>
  <section class="image-generation-settings">
    <div class="image-generation-heading">
      <h4>生图与改图</h4>
      <ToggleSwitch
        v-model="enabled"
        label="生图与改图"
        :disabled="
          loading || outputFormat !== 'text' || (!candidates.length && !enabled)
        "
      />
    </div>
    <p>
      允许使用生图插件生成新图片，或导入聊天中的图片进行修改，结果作为一张 PNG
      回复附件发送。可与沙箱同时启用：图表、示意图和文件处理仍由沙箱完成。
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="loading">正在读取已批准的生图插件能力…</p>
    <p v-else-if="outputFormat !== 'text'">将输出格式设为“文本”后可启用。</p>
    <p v-else-if="!candidates.length">
      请先部署生图插件，发现并授权其工具，再允许本节点使用该插件。
    </p>
    <label v-if="enabled"
      >生图插件<select
        :value="selected ? key(selected) : ''"
        @change="choose(($event.target as HTMLSelectElement).value)"
      >
        <option value="" disabled>请选择生图插件</option>
        <option
          v-for="target in candidates"
          :key="key(target)"
          :value="key(target)"
        >
          {{ target.pluginName }} · {{ target.server }}
        </option>
      </select></label
    >
    <p v-if="enabled && selected && inputTypes">
      可修改的图片格式：{{ inputTypes }}；iPhone 的 HEIC 照片会先转为 JPEG。
    </p>
    <p v-if="enabled">
      将“回复附件”和“文本输出”连接到同一个发送节点。生图按次计费，次数与质量上限在插件配置中调整；不支持引用回复或调度触发。
    </p>
  </section>
</template>
<style scoped>
.image-generation-settings {
  display: grid;
  gap: 10px;
  border-top: 1px solid var(--bubblepilot-line, #dbe3ec);
  padding-top: 16px;
  min-width: 0;
}
.image-generation-heading {
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
