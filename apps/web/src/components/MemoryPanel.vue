<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { apiRequest, errorMessage, jsonBody } from "../services/api";
import { useSessionStore } from "../stores/session";
import SensitiveUnlock from "./SensitiveUnlock.vue";
const props = defineProps<{
  mode: "settings" | "chat" | "jobs";
  chats?: readonly {
    id: string;
    displayName?: string | null;
    providerChatId?: string;
  }[];
}>();
const session = useSessionStore();
const busy = ref(false);
const error = ref("");
const notice = ref("");
const chatId = ref("");
const query = ref("");
const from = ref("");
const to = ref("");
interface Generation {
  id: string;
  model: string;
  dimensions: number;
  status: string;
}
interface Settings {
  enabled: boolean;
  protocol: "ollama" | "openai-compatible";
  baseUrl: string;
  model: string;
  dimensions: number;
  modelVersion: string;
  queryPrefix: string;
  version: number;
  secretConfigured: boolean;
  databaseReady: boolean;
  generations: Generation[];
}
interface Job {
  id: string;
  chat_id: string;
  generation_id: string;
  status: string;
  version: number;
  cursor_index: string;
  through_index: string;
  error_code: string | null;
}
interface SearchResult {
  status: string;
  retrievalMode: string;
  retrievalId: string;
  coverage: { total: number; indexed: number; pending: number };
  evidence: { ref: string; text: string }[];
}
const settings = ref<Settings | null>(null);
const secret = ref("");
const generationId = ref("");
const jobs = ref<Job[]>([]);
const result = ref<SearchResult | null>(null);
const source = ref("");
const chat = reactive({
  enabled: false,
  version: 0,
  coverage: null as {
    total: number;
    indexed: number;
    pending: number;
    failed?: number;
  } | null,
});
let epoch = 0;
let alive = true;
let requestKey = crypto.randomUUID();
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  const token = epoch;
  try {
    await action();
  } catch (e) {
    if (alive && token === epoch) error.value = errorMessage(e);
  } finally {
    if (alive) busy.value = false;
  }
}
async function refresh() {
  const token = ++epoch;
  const value = await apiRequest<Settings>("/api/v1/ai/memory/settings");
  if (!alive || token !== epoch) return;
  settings.value = value;
  generationId.value =
    value.generations.find((g) => g.status === "building")?.id ??
    value.generations.find((g) => g.status === "active")?.id ??
    "";
  if (props.mode === "jobs") {
    const rows = await apiRequest<Job[]>("/api/v1/memory/jobs");
    if (alive && token === epoch) jobs.value = rows;
  }
  if (props.mode === "chat" && chatId.value) {
    const path = `/api/v1/chats/${chatId.value}/memory`;
    const [state, rows] = await Promise.all([
      apiRequest<typeof chat>(path),
      apiRequest<Job[]>(`${path}/jobs`),
    ]);
    if (alive && token === epoch) {
      Object.assign(chat, state);
      jobs.value = rows;
    }
  }
}
function payload() {
  if (!settings.value) throw new Error("配置尚未加载");
  const {
    version,
    enabled,
    protocol,
    baseUrl,
    model,
    dimensions,
    modelVersion,
    queryPrefix,
  } = settings.value;
  return {
    enabled,
    protocol,
    baseUrl,
    model,
    dimensions,
    modelVersion,
    queryPrefix,
    expectedVersion: version,
    ...(secret.value ? { secret: secret.value } : {}),
  };
}
async function save() {
  if (!session.sensitiveActive) return;
  await apiRequest("/api/v1/ai/memory/settings", {
    method: "PUT",
    body: jsonBody(payload()),
  });
  secret.value = "";
  notice.value = "配置已保存；历史记录不会自动补建。";
  await refresh();
}
async function probe() {
  if (!session.sensitiveActive) return;
  await apiRequest("/api/v1/ai/memory/probe", {
    method: "POST",
    body: jsonBody(payload()),
  });
  notice.value = "连接与输出维度验证通过。";
}
async function authorize() {
  if (!session.sensitiveActive) return;
  await apiRequest(`/api/v1/chats/${chatId.value}/memory`, {
    method: "PUT",
    body: jsonBody({ enabled: !chat.enabled, expectedVersion: chat.version }),
  });
  await refresh();
}
async function search() {
  if (!session.sensitiveActive) return;
  const token = epoch;
  const value = await apiRequest<SearchResult>(
    `/api/v1/chats/${chatId.value}/memory/search`,
    {
      method: "POST",
      body: jsonBody({
        query: query.value,
        ...(from.value ? { from: new Date(from.value).toISOString() } : {}),
        ...(to.value ? { to: new Date(to.value).toISOString() } : {}),
      }),
    },
  );
  if (alive && token === epoch && session.sensitiveActive) result.value = value;
}
async function backfill() {
  if (!session.sensitiveActive) return;
  await apiRequest(`/api/v1/chats/${chatId.value}/memory/jobs`, {
    method: "POST",
    body: jsonBody({
      generationId: generationId.value,
      requestKey,
      ...(from.value ? { from: new Date(from.value).toISOString() } : {}),
      ...(to.value ? { to: new Date(to.value).toISOString() } : {}),
    }),
  });
  requestKey = crypto.randomUUID();
  await refresh();
}
async function action(job: Job, name: string) {
  if (!session.sensitiveActive) return;
  await apiRequest(`/api/v1/memory/jobs/${job.id}/actions`, {
    method: "POST",
    body: jsonBody({ action: name, expectedVersion: job.version }),
  });
  await refresh();
}
async function viewSource(ref: string) {
  if (!session.sensitiveActive || !result.value) return;
  const token = epoch;
  const value = await apiRequest<{
    messages: { sentAt: string; senderId: string; text: string }[];
  }>(`/api/v1/memory/retrievals/${result.value.retrievalId}/sources/${ref}`);
  if (alive && token === epoch && session.sensitiveActive)
    source.value = value.messages
      .map((m) => `${m.sentAt} ${m.senderId}\n${m.text}`)
      .join("\n\n");
}
watch(chatId, () => {
  epoch++;
  result.value = null;
  source.value = "";
  query.value = "";
  requestKey = crypto.randomUUID();
  void run(refresh);
});
watch(
  () => session.sensitiveActive,
  (active) => {
    if (!active) {
      epoch++;
      result.value = null;
      source.value = "";
      query.value = "";
      secret.value = "";
    }
  },
);
function onToggle(event: Event) {
  if (event.target instanceof HTMLDetailsElement && !event.target.open) {
    epoch++;
    result.value = null;
    source.value = "";
    query.value = "";
    secret.value = "";
  }
}
onMounted(() => void run(refresh));
onBeforeUnmount(() => {
  alive = false;
  epoch++;
  result.value = null;
  source.value = "";
  secret.value = "";
});
</script>
<template>
  <details class="memory-panel" :open="mode === 'settings'" @toggle="onToggle">
    <summary>
      {{
        mode === "settings"
          ? "长期聊天检索设置"
          : mode === "chat"
            ? "聊天长期记忆"
            : "历史索引任务"
      }}
    </summary>
    <p>
      AI
      根据问题自行查找已授权聊天中的历史记录，无需添加工作流节点。可检索范围受消息保留期限限制。
    </p>
    <SensitiveUnlock />
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <button class="button" :disabled="busy" @click="run(refresh)">
      {{ busy ? "处理中…" : "刷新状态" }}
    </button>
    <form v-if="mode === 'settings' && settings" @submit.prevent="run(save)">
      <p>
        数据库：{{
          settings.databaseReady ? "已准备" : "需要安装 pgvector"
        }}；凭据：{{ settings.secretConfigured ? "已配置" : "未配置" }}
      </p>
      <fieldset :disabled="busy || !session.sensitiveActive">
        <label
          ><input
            v-model="settings.enabled"
            type="checkbox"
          />启用长期检索</label
        >
        <label
          >服务协议<select v-model="settings.protocol">
            <option value="ollama">Ollama</option>
            <option value="openai-compatible">OpenAI 兼容 Embedding API</option>
          </select></label
        >
        <label
          >服务地址<input v-model="settings.baseUrl" type="url" required
        /></label>
        <label>模型<input v-model="settings.model" required /></label>
        <label
          >向量维度<input
            v-model.number="settings.dimensions"
            type="number"
            min="1"
            max="16000"
            required
        /></label>
        <label
          >模型版本标识<input v-model="settings.modelVersion" required
        /></label>
        <label>问题编码前缀<textarea v-model="settings.queryPrefix" /></label>
        <label
          >更新凭据（留空保留）<input
            v-model="secret"
            type="password"
            autocomplete="new-password"
        /></label>
        <p>
          索引文本会发送到上述服务；检索出的证据会发送到当前对话
          Provider。模型变化需要补建新代次并显式切换。
        </p>
        <button class="button" type="button" @click="run(probe)">
          测试连接
        </button>
        <button class="button primary" type="submit">保存配置</button>
      </fieldset>
    </form>
    <div v-if="mode === 'chat'">
      <label
        >聊天<select v-model="chatId" :disabled="busy">
          <option value="">选择聊天</option>
          <option v-for="item in chats" :key="item.id" :value="item.id">
            {{ item.displayName || item.providerChatId || item.id }}
          </option>
        </select></label
      >
      <template v-if="chatId">
        <p>
          {{
            !settings?.enabled
              ? "全局检索尚未启用"
              : chat.enabled
                ? "检索已启用"
                : "聊天检索未启用"
          }}；已索引 {{ chat.coverage?.indexed ?? 0 }} /
          {{ chat.coverage?.total ?? 0 }} 条保留消息。尚未完成
          {{ chat.coverage?.pending ?? 0 }} 条，其中失败缺口
          {{ chat.coverage?.failed ?? 0 }} 条。
        </p>
        <button
          class="button"
          :disabled="busy || !session.sensitiveActive"
          @click="run(authorize)"
        >
          {{ chat.enabled ? "停用检索" : "授权此聊天检索" }}
        </button>
        <fieldset
          :disabled="
            busy ||
            !session.sensitiveActive ||
            !chat.enabled ||
            !settings?.enabled
          "
        >
          <label
            >开始时间（本地时区）<input
              v-model="from"
              type="datetime-local" /></label
          ><label
            >结束时间（本地时区）<input v-model="to" type="datetime-local"
          /></label>
          <label
            >索引代次<select v-model="generationId">
              <option
                v-for="g in settings?.generations"
                :key="g.id"
                :value="g.id"
              >
                {{ g.model }} · {{ g.status }}
              </option>
            </select></label
          >
          <button
            class="button"
            :disabled="!generationId"
            @click="run(backfill)"
          >
            补建所选范围（留空表示全部保留记录）
          </button>
          <label>测试问题<input v-model="query" maxlength="500" /></label
          ><button
            class="button"
            :disabled="!query.trim()"
            @click="run(search)"
          >
            测试检索
          </button>
        </fieldset>
        <div v-if="result && session.sensitiveActive">
          <p>{{ result.status }} · {{ result.retrievalMode }}</p>
          <article v-for="item in result.evidence" :key="item.ref">
            <button
              class="button"
              :disabled="busy"
              @click="run(() => viewSource(item.ref))"
            >
              查看来源 {{ item.ref }}
            </button>
            <pre>{{ item.text }}</pre>
          </article>
        </div>
        <pre v-if="source && session.sensitiveActive">{{ source }}</pre>
      </template>
    </div>
    <div v-if="mode !== 'settings'" class="memory-jobs">
      <article v-for="job in jobs" :key="job.id">
        <p>
          {{ job.status }} · {{ job.cursor_index }} / {{ job.through_index }}
          <span v-if="job.error_code">{{ job.error_code }}</span>
        </p>
        <button
          v-if="['queued', 'running'].includes(job.status)"
          class="button"
          :disabled="busy || !session.sensitiveActive"
          @click="run(() => action(job, 'pause'))"
        >
          暂停
        </button>
        <button
          v-if="['paused', 'failed'].includes(job.status)"
          class="button"
          :disabled="busy || !session.sensitiveActive"
          @click="run(() => action(job, 'resume'))"
        >
          恢复
        </button>
        <button
          v-if="['queued', 'running', 'paused', 'failed'].includes(job.status)"
          class="button"
          :disabled="busy || !session.sensitiveActive"
          @click="run(() => action(job, 'cancel'))"
        >
          取消
        </button>
        <button
          v-if="
            job.status === 'succeeded' &&
            settings?.generations.some(
              (g) => g.id === job.generation_id && g.status === 'building',
            )
          "
          class="button"
          :disabled="busy || !session.sensitiveActive"
          @click="run(() => action(job, 'activate'))"
        >
          验证覆盖并启用此代次
        </button>
      </article>
    </div>
  </details>
</template>
<style scoped>
.memory-panel {
  background: rgba(255, 255, 255, 0.72);
  padding: 1rem;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 12px;
  margin-block: 1rem;
  grid-column: 1/-1;
}
.memory-panel summary {
  cursor: pointer;
  font-weight: 600;
}
.memory-panel fieldset {
  border: 0;
  padding: 0;
  display: grid;
  gap: 0.75rem;
}
.memory-panel label {
  display: grid;
  gap: 0.35rem;
  margin-block: 0.5rem;
}
.memory-panel pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.memory-jobs {
  max-height: 24rem;
  overflow: auto;
}
.memory-jobs article {
  border-top: 1px solid #ddd;
  padding: 0.5rem;
}

.memory-panel .button {
  width: fit-content;
  justify-self: start;
}
.memory-panel [role="alert"] {
  color: #a32929;
}
@media (min-width: 760px) {
  .memory-panel fieldset {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .memory-panel fieldset > p,
  .memory-panel label:has(textarea) {
    grid-column: 1 / -1;
  }
}
</style>
