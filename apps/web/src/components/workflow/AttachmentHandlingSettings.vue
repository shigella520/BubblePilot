<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import AdminDetailDialog from "../AdminDetailDialog.vue";
import { apiRequest } from "../../services/api";
import {
  attachmentLimitsSchema,
  type AttachmentHandling,
  type AttachmentLimits,
} from "../../../../../modules/attachments/attachment-policy";
const props = defineProps<{
  modelValue?: AttachmentHandling;
  pluginIds: string[];
  outputFormat: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: AttachmentHandling];
}>();
interface Target {
  pluginId: string;
  pluginName: string;
  server: string;
}
const targets = ref<Target[]>([]);
const loading = ref(true);
const error = ref("");
const showLimits = ref(false);
const draft = ref(attachmentLimitsSchema.parse({}));
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
const validDraft = computed(
  () => attachmentLimitsSchema.safeParse(draft.value).success,
);
const fields: Array<{
  key: keyof AttachmentLimits;
  label: string;
  min: number;
  max: number;
}> = [
  { key: "fileMiB", label: "单文件上限（MiB）", min: 1, max: 20 },
  { key: "files", label: "每次任务文件数", min: 1, max: 5 },
  { key: "totalMiB", label: "每次任务累计（MiB）", min: 1, max: 50 },
  { key: "timeoutSeconds", label: "导入时限（秒）", min: 5, max: 45 },
  { key: "expandedMiB", label: "解压累计（MiB）", min: 1, max: 100 },
  { key: "expandedFiles", label: "解压文件数", min: 1, max: 500 },
];
onMounted(async () => {
  try {
    targets.value = await apiRequest<Target[]>(
      "/api/v1/plugins/attachment-targets",
    );
  } catch {
    error.value = "沙箱能力读取失败，请重新打开节点重试。";
  } finally {
    loading.value = false;
  }
});
function update(change: Partial<AttachmentHandling>) {
  emit("update:modelValue", {
    enabled: false,
    pluginId: "",
    server: "",
    limits: attachmentLimitsSchema.parse({}),
    ...props.modelValue,
    ...change,
  });
}
function enable(value: boolean) {
  const target =
    !props.modelValue?.pluginId && candidates.value.length === 1
      ? candidates.value[0]
      : undefined;
  update({
    enabled: value,
    ...(target ? { pluginId: target.pluginId, server: target.server } : {}),
  });
}
function select(value: string) {
  const target = candidates.value.find(
    (t) => JSON.stringify([t.pluginId, t.server]) === value,
  );
  if (target) update({ pluginId: target.pluginId, server: target.server });
}
function editLimits() {
  draft.value = attachmentLimitsSchema.parse(props.modelValue?.limits ?? {});
  showLimits.value = true;
}
function applyLimits() {
  if (validDraft.value) {
    update({ limits: attachmentLimitsSchema.parse(draft.value) });
    showLimits.value = false;
  }
}
</script>
<template>
  <section class="attachment-settings">
    <h4>聊天附件处理</h4>
    <label class="attachment-toggle"
      ><input
        type="checkbox"
        :checked="modelValue?.enabled ?? false"
        :disabled="
          outputFormat !== 'text' ||
          loading ||
          (!candidates.length && !modelValue?.enabled)
        "
        @change="enable(($event.target as HTMLInputElement).checked)"
      />允许使用沙箱处理聊天附件</label
    >
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="loading">正在读取已批准的沙箱能力…</p>
    <p v-else-if="outputFormat !== 'text'">将输出格式设为“文本”后可启用。</p>
    <p v-else-if="!candidates.length">
      请先启用支持附件传输的沙箱插件，并批准准备、命令、读写文件四个工具；旧服务需要升级并重新测试批准。
    </p>
    <template v-if="modelValue?.enabled">
      <label v-if="candidates.length > 1 || !selected"
        >附件处理沙箱
        <select
          :value="
            selected ? JSON.stringify([selected.pluginId, selected.server]) : ''
          "
          @change="select(($event.target as HTMLSelectElement).value)"
        >
          <option disabled value="">请选择接收附件的服务</option>
          <option
            v-for="target in candidates"
            :key="JSON.stringify([target.pluginId, target.server])"
            :value="JSON.stringify([target.pluginId, target.server])"
          >
            {{ target.pluginName }} · {{ target.server }}
          </option>
        </select>
      </label>
      <p v-else>
        附件处理沙箱：{{ selected.pluginName }} · {{ selected.server }}
      </p>
      <p v-if="!selected" role="alert">
        绑定尚未完成或原服务已不可用；不会自动切换目标。
      </p>
      <p>
        发布后，该服务可按本轮请求接收当前及授权历史附件。文件仅在本次任务内使用，最终回复文字，不回传文件。
      </p>
      <button type="button" class="button secondary" @click="editLimits">
        附件额度设置
      </button>
    </template>
    <AdminDetailDialog
      v-if="showLimits"
      title="附件处理额度"
      @close="showLimits = false"
    >
      <form class="attachment-limits" @submit.prevent="applyLimits">
        <label v-for="field in fields" :key="field.key"
          >{{ field.label
          }}<input
            v-model.number="draft[field.key]"
            type="number"
            required
            :min="field.min"
            :max="field.max"
        /></label>
        <p>
          累计上限不能小于单文件上限。导入与其他工具共享任务时间及次数预算。
        </p>
        <p v-if="!validDraft" role="alert">请检查数值范围和累计上限。</p>
        <button type="submit" class="button" :disabled="!validDraft">
          应用到节点草稿
        </button>
      </form>
    </AdminDetailDialog>
  </section>
</template>
<style scoped>
.attachment-settings {
  display: grid;
  gap: 12px;
  border-top: 1px solid var(--border-color, #e5e7eb);
  padding-top: 16px;
  margin-top: 16px;
}
.attachment-settings p {
  font-size: 13px;
  color: var(--text-muted, #64748b);
  line-height: 1.6;
}
.attachment-settings label,
.attachment-limits label {
  display: grid;
  gap: 8px;
}
.attachment-settings .attachment-toggle {
  display: flex;
  gap: 8px;
  align-items: center;
}
.attachment-settings select {
  width: 100%;
  min-width: 0;
}
.attachment-limits {
  display: grid;
  gap: 16px;
}
</style>
