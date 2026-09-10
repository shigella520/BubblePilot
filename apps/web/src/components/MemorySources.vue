<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { apiRequest, errorMessage } from "../services/api";
import { useSessionStore } from "../stores/session";
const props = defineProps<{ retrievalId: string; refs: string[] }>();
const session = useSessionStore();
const text = ref("");
const error = ref("");
const busy = ref(false);
let version = 0;
async function show(ref: string) {
  if (!session.sensitiveActive || busy.value) return;
  const token = ++version;
  busy.value = true;
  try {
    const result = await apiRequest<{
      messages: { text: string; sentAt: string; senderId: string }[];
    }>(`/api/v1/memory/retrievals/${props.retrievalId}/sources/${ref}`);
    if (token === version && session.sensitiveActive)
      text.value = result.messages
        .map((m) => `${m.sentAt} ${m.senderId}\n${m.text}`)
        .join("\n\n");
  } catch (e) {
    if (token === version) error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
function clear() {
  version++;
  text.value = "";
  error.value = "";
}
watch(
  () => session.sensitiveActive,
  (active) => {
    if (!active) clear();
  },
);
watch(() => props.retrievalId, clear);
onBeforeUnmount(clear);
</script>
<template>
  <div>
    <button
      v-for="sourceRef in refs"
      :key="sourceRef"
      class="button"
      :disabled="!session.sensitiveActive || busy"
      @click="show(sourceRef)"
    >
      查看历史来源 {{ sourceRef }}
    </button>
    <p v-if="!session.sensitiveActive">解锁敏感操作后可查看来源正文。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="text && session.sensitiveActive"
      ><button class="button" @click="clear">收起正文</button>
      <pre>{{ text }}</pre>
    </template>
  </div>
</template>
<style scoped>
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
