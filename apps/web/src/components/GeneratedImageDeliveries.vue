<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { apiRequest, downloadFile } from "../services/api";
const props = defineProps<{ executionId: string; sensitiveActive: boolean }>();
interface Item {
  id: string;
  width: number | null;
  height: number | null;
  filename: string;
  mimeType: string;
  fileType: string;
  size: number;
  state: string;
  deliveryStatus: string | null;
  errorCode: string | null;
}
const items = ref<Item[]>([]),
  error = ref(""),
  busy = ref<string | null>(null),
  previews = ref<Record<string, string>>({});
let generation = 0,
  previewGeneration = 0;
function clear() {
  previewGeneration++;
  for (const url of Object.values(previews.value)) URL.revokeObjectURL(url);
  previews.value = {};
  busy.value = null;
}
watch(
  () => props.executionId,
  async (id) => {
    const version = ++generation;
    clear();
    items.value = [];
    error.value = "";
    try {
      const result = await apiRequest<Item[]>(
        `/api/v1/executions/${id}/generated-images`,
      );
      if (version === generation) items.value = result;
    } catch {
      if (version === generation)
        error.value = "附件记录加载失败，请重新打开详情。";
    }
  },
  { immediate: true },
);
watch(
  () => props.sensitiveActive,
  (active) => {
    if (!active) clear();
  },
);
onBeforeUnmount(() => {
  generation++;
  clear();
});
async function preview(item: Item) {
  if (!props.sensitiveActive || busy.value) return;
  const version = previewGeneration;
  busy.value = item.id;
  error.value = "";
  try {
    const { blob } = await downloadFile(
      `/api/v1/executions/${props.executionId}/generated-images/${item.id}/content`,
    );
    if (version !== previewGeneration || !props.sensitiveActive) return;
    if (item.mimeType.startsWith("image/")) {
      if (previews.value[item.id]) URL.revokeObjectURL(previews.value[item.id]);
      previews.value[item.id] = URL.createObjectURL(blob);
    } else {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = item.filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch {
    if (version === previewGeneration)
      error.value = "附件已过期、不可用或需要重新解锁敏感操作。";
  } finally {
    if (version === previewGeneration) busy.value = null;
  }
}
const states: Record<string, string> = {
  ready: "已准备，未投递",
  bound: "已登记投递",
  deleting: "清理中",
  deleted: "已清理",
  confirmed: "发送已确认",
  pending: "等待发送",
  sending: "发送中",
  failed: "发送失败",
  unknown: "投递结果未知",
};
</script>
<template>
  <section v-if="items.length || error" class="generated-images">
    <h4>附件回复</h4>
    <p v-if="error" role="alert">{{ error }}</p>
    <article v-for="item in items" :key="item.id">
      <div class="generated-image-row">
        <span
          >{{ item.filename }} · {{ item.fileType.toUpperCase() }}
          <template v-if="item.width && item.height">
            · {{ item.width }} × {{ item.height }}</template
          >
          · {{ Math.ceil(item.size / 1024) }} KiB</span
        ><strong>{{
          states[item.deliveryStatus ?? item.state] ?? item.state
        }}</strong
        ><button
          v-if="item.state === 'ready' || item.state === 'bound'"
          type="button"
          :disabled="!sensitiveActive || busy !== null"
          @click="preview(item)"
        >
          {{
            busy === item.id
              ? "加载中…"
              : item.mimeType.startsWith("image/")
                ? "预览"
                : "下载"
          }}
        </button>
      </div>
      <p v-if="item.errorCode">{{ item.errorCode }}</p>
      <p
        v-if="
          !sensitiveActive && (item.state === 'ready' || item.state === 'bound')
        "
      >
        解锁敏感操作后可预览图片或下载文件。
      </p>
      <img
        v-if="previews[item.id]"
        :src="previews[item.id]"
        alt="本次执行生成的图片"
      />
    </article>
  </section>
</template>
<style scoped>
.generated-images {
  display: grid;
  gap: 12px;
  min-width: 0;
}
h4,
p {
  margin: 0;
}
article {
  border: 1px solid var(--bubblepilot-border, #dbe3ec);
  border-radius: 12px;
  padding: 12px;
  display: grid;
  gap: 10px;
  min-width: 0;
}
.generated-image-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.generated-image-row span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
@media (max-width: 600px) {
  .generated-image-row span {
    flex: 1 0 100%;
  }
  .generated-image-row button {
    margin-left: auto;
  }
}
p {
  font-size: 13px;
  overflow-wrap: anywhere;
}
img {
  display: block;
  max-width: 100%;
  max-height: 640px;
  object-fit: contain;
  border-radius: 8px;
}
</style>
