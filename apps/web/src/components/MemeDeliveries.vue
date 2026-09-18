<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted } from "vue";
import { apiRequest } from "../services/api";
import { useRoute } from "vue-router";
const props = defineProps<{
  executionId?: string;
  sensitiveActive?: boolean;
}>();
const route = useRoute();
const statusLabels: Record<string, string> = {
  pending: "等待发送",
  sending: "发送中",
  confirmed: "已确认",
  failed: "发送失败",
  unknown: "结果未知",
};
interface Delivery {
  id: string;
  executionId: string;
  memeId: string;
  memeName: string;
  status: string;
  textStatus: string;
  durationMs: number | null;
  errorSummary: string | null;
  closedAt: string | null;
  retryable: boolean;
}
const items = ref<Delivery[]>([]),
  busy = ref(false),
  error = ref("");
let requestSequence = 0;
onUnmounted(() => {
  requestSequence++;
});
async function load() {
  const sequence = ++requestSequence;
  try {
    const loaded = await apiRequest<Delivery[]>(
      `/api/v1/meme-deliveries${props.executionId ? `?executionId=${props.executionId}` : ""}`,
    );
    if (sequence !== requestSequence) return;
    items.value = loaded;
    error.value = "";
    await nextTick();
    if (typeof route.query.deliveryId === "string")
      document
        .getElementById(`meme-delivery-${route.query.deliveryId}`)
        ?.scrollIntoView({ block: "center" });
  } catch {
    if (sequence !== requestSequence) return;
    error.value = "表情投递状态加载失败，请重试。";
  }
}
async function act(item: Delivery, action: "retry" | "close") {
  if (
    busy.value ||
    !window.confirm(
      action === "retry"
        ? "仅重试这张图片，文字不会重发。确认继续？"
        : "关闭该图片的跟进，保留原始投递结果。确认继续？",
    )
  )
    return;
  busy.value = true;
  try {
    await apiRequest(`/api/v1/meme-deliveries/${item.id}/${action}`, {
      method: "POST",
    });
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "处置失败。";
  } finally {
    busy.value = false;
  }
}
watch(
  () => props.executionId,
  () => void load(),
  { immediate: true },
);
</script>
<template>
  <section>
    <h3>{{ executionId ? "表情投递" : "表情待处理" }}</h3>
    <p v-if="error" role="alert">
      {{ error }} <button class="button secondary" @click="load">重试</button>
    </p>
    <p v-if="!items.length && !error">
      暂无表情{{ executionId ? "投递" : "待处理项" }}。
    </p>
    <article
      v-for="item in items"
      :id="`meme-delivery-${item.id}`"
      :key="item.id"
      class="meme-delivery"
    >
      <img
        :src="`/api/v1/meme-deliveries/${item.id}/thumbnail`"
        alt="表情缩略图"
      />
      <div>
        <strong>{{ item.memeName }}</strong>
        <p>
          图片：{{ statusLabels[item.status] ?? item.status }} ·
          {{ item.durationMs ?? 0 }} ms
          {{ item.closedAt ? "· 已关闭跟进" : "" }}
        </p>
        <p>{{ item.errorSummary }}</p>
        <p v-if="item.status !== 'confirmed'">
          {{
            item.textStatus === "confirmed"
              ? "文字已发送，表情未完成。"
              : "正文尚未确认，表情不会发送。"
          }}
        </p>
        <RouterLink
          v-if="!executionId"
          :to="`/executions?executionId=${item.executionId}&deliveryId=${item.id}`"
          >定位投递记录</RouterLink
        ><template
          v-else-if="
            !item.closedAt && ['failed', 'unknown'].includes(item.status)
          "
          ><button
            v-if="item.status === 'failed' && item.retryable"
            class="button secondary"
            :disabled="busy || !sensitiveActive"
            @click="act(item, 'retry')"
          >
            仅重试图片</button
          ><button
            class="button secondary"
            :disabled="busy || !sensitiveActive"
            @click="act(item, 'close')"
          >
            关闭跟进</button
          ><span v-if="!sensitiveActive">请先在顶栏解锁敏感操作</span></template
        >
      </div>
    </article>
  </section>
</template>
<style scoped>
.meme-delivery {
  display: flex;
  gap: 16px;
  padding: 16px;
  border-bottom: 1px solid #aaa3;
  scroll-margin-top: 100px;
}
.meme-delivery img {
  width: 64px;
  height: 64px;
  object-fit: contain;
}
</style>
