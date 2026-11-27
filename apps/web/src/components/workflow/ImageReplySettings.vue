<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import ToggleSwitch from "../ToggleSwitch.vue";
import { apiRequest } from "../../services/api";
import {
  type ImageReply,
  type ReplyFileType,
  replyFileTypes,
} from "../../../../../modules/generated-images/image-policy";
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
  kind?: "sandbox" | "generator";
  fileTypes?: string[];
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
// Image generators are bound separately in the image generation section.
const candidates = computed(() =>
  targets.value.filter(
    (t) => t.kind !== "generator" && props.pluginIds.includes(t.pluginId),
  ),
);
const selected = computed(() =>
  candidates.value.find(
    (t) =>
      t.pluginId === props.modelValue?.pluginId &&
      t.server === props.modelValue?.server,
  ),
);
const allowed = computed<ReplyFileType[]>(
  () => props.modelValue?.allowedTypes ?? ["png"],
);
const labels: Record<ReplyFileType, string> = {
  png: "PNG 图片",
  jpeg: "JPEG 图片",
  gif: "GIF 动图",
  pdf: "PDF 文档",
  xlsx: "Excel 表格",
  csv: "CSV 数据",
  txt: "纯文本",
  md: "Markdown",
  zip: "ZIP 压缩包",
};
function toggleType(type: ReplyFileType, checked: boolean) {
  update({
    allowedTypes: checked
      ? [...allowed.value, type]
      : allowed.value.filter((v) => v !== type),
  });
}
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
  if (target)
    update({
      pluginId: target.pluginId,
      server: target.server,
      allowedTypes: allowed.value.filter((v) =>
        (target.fileTypes ?? ["png"]).includes(v),
      ),
    });
}
</script>
<template>
  <section class="image-reply-settings">
    <div class="image-reply-heading">
      <h4>附件回复</h4>
      <ToggleSwitch
        v-model="enabled"
        label="附件回复"
        :disabled="
          loading || outputFormat !== 'text' || (!candidates.length && !enabled)
        "
      />
    </div>
    <p>
      允许将本次沙箱中的一个文件发到当前聊天，可配说明文字。图片最多 8
      MiB，其他文件最多 20 MiB。GIF 保留动画，最多 200 帧、累计 6400 万像素。
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="loading">正在读取已批准的图片导出能力…</p>
    <p v-else-if="outputFormat !== 'text'">将输出格式设为“文本”后可启用。</p>
    <p v-else-if="!candidates.length">
      请先升级沙箱插件和运行镜像，发现并授权工具，再允许本节点使用该插件。
    </p>
    <label v-if="enabled"
      >附件输出沙箱<select
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
    <fieldset v-if="enabled && selected" class="file-types">
      <legend>允许回复的文件类型（至少选择一项）</legend>
      <label v-for="type in replyFileTypes" :key="type">
        <input
          type="checkbox"
          :checked="allowed.includes(type)"
          :disabled="
            !(selected.fileTypes ?? ['png']).includes(type) &&
            !allowed.includes(type)
          "
          @change="
            toggleType(type, ($event.target as HTMLInputElement).checked)
          "
        />{{ labels[type] }}
      </label>
      <p v-if="!(selected.fileTypes ?? ['png']).includes('pdf')">
        当前已授权能力仅支持
        PNG；升级沙箱服务并重新发现、保存授权后可选择其他类型。
      </p>
      <p v-if="!allowed.length" role="alert">请至少选择一种文件类型。</p>
    </fieldset>
    <p v-if="enabled">
      将“回复附件”和“文本输出”连接到同一个发送节点。若启用附件处理，选择相同沙箱；不支持引用回复或调度触发。旧图片配置默认仅允许
      PNG。
    </p>
  </section>
</template>
<style scoped>
.image-reply-settings {
  display: grid;
  gap: 10px;
  border-top: 1px solid var(--bubblepilot-line, #dbe3ec);
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
.file-types {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 18px;
  min-width: 0;
  border: 1px solid var(--bubblepilot-line, #dbe3ec);
  border-radius: 10px;
  padding: 12px;
}
.file-types label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.file-types p {
  flex-basis: 100%;
}
legend {
  max-width: 100%;
  font-size: 13px;
  overflow-wrap: anywhere;
}
</style>
