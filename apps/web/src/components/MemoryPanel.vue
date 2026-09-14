<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  apiRequest,
  apiPageRequest,
  errorMessage,
  jsonBody,
} from "../services/api";
import { useSessionStore } from "../stores/session";
import { ProgressPoller } from "../services/progress-poller";
import AdminDetailDialog from "./AdminDetailDialog.vue";
import CursorPagination from "./CursorPagination.vue";
import DismissibleMessage from "./DismissibleMessage.vue";
import { RefreshCw } from "@lucide/vue";
import SensitiveUnlock from "./SensitiveUnlock.vue";
const props = defineProps<{
  mode: "settings" | "chat" | "jobs";
  embedded?: boolean;
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
const searchFrom = ref("");
const searchTo = ref("");
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
  reason: string;
  id: string;
  created_at: string;
  updated_at: string;
  attempts: number;
  chat_id: string;
  generation_id: string;
  status: string;
  version: number;
  cursor_index: string;
  through_index: string;
  error_code: string | null;
  request_key: string | null;
  chat_name: string | null;
  model: string;
  range_from: string | null;
  range_to: string | null;
  progress?: {
    scope: string | null;
    total: number;
    processed: number;
    removed: number;
    remaining: number;
    percent: number | null;
    lastProgressAt: string | null;
    generatedAt: string;
    estimate: {
      status: string;
      messagesPerMinute: number | null;
      remainingSeconds: number | null;
      estimatedCompletionAt: string | null;
    };
  };
}
function jobKind(job: Job) {
  if (job.reason === "rebuild") return "角色历史索引重建";
  return job.request_key || job.reason !== "incremental"
    ? "历史补建"
    : "新增消息索引";
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
const selectedJob = ref<Job | null>(null);
const jobTrigger = ref<HTMLElement | null>(null);
const jobPage = ref(1);
const jobCursors = ref<Array<string | null>>([null]);
const nextJobCursor = ref<string | null>(null);
function resetJobPage() {
  jobPage.value = 1;
  jobCursors.value = [null];
  nextJobCursor.value = null;
  selectedJob.value = null;
}
function jobsPath() {
  const base =
    props.mode === "chat"
      ? `/api/v1/chats/${chatId.value}/memory/jobs`
      : "/api/v1/memory/jobs";
  const params = new URLSearchParams({ limit: "25" });
  const cursor = jobCursors.value[jobPage.value - 1];
  if (cursor) params.set("cursor", cursor);
  return `${base}?${params}`;
}
async function loadJobPage() {
  const token = epoch;
  const page = await apiPageRequest<Job[]>(jobsPath());
  const detail = selectedJob.value
    ? await apiRequest<Job>(`/api/v1/memory/jobs/${selectedJob.value.id}`)
    : null;
  if (alive && token === epoch) {
    jobs.value = page.data;
    nextJobCursor.value = page.page.nextCursor;
    selectedJob.value = detail;
    progressError.value = false;
  }
}
async function turnJobPage(direction: number) {
  const previousPage = jobPage.value;
  const previousCursors = [...jobCursors.value];
  const token = epoch;
  if (direction > 0 && nextJobCursor.value) {
    jobCursors.value = jobCursors.value.slice(0, jobPage.value);
    jobCursors.value.push(nextJobCursor.value);
    jobPage.value++;
  } else if (direction < 0 && jobPage.value > 1) jobPage.value--;
  selectedJob.value = null;
  try {
    await loadJobPage();
  } catch (error) {
    if (alive && token === epoch) {
      jobPage.value = previousPage;
      jobCursors.value = previousCursors;
    }
    throw error;
  }
}
async function showJob(job: Job, trigger: EventTarget | null) {
  jobTrigger.value = trigger instanceof HTMLElement ? trigger : null;
  const token = epoch;
  const detail = await apiRequest<Job>(`/api/v1/memory/jobs/${job.id}`);
  if (alive && token === epoch) selectedJob.value = detail;
}
function closeJob() {
  epoch++;
  selectedJob.value = null;
  poller.invalidate();
}
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
const progressError = ref(false);
let panelOpen = !!props.embedded;

const stateNames: Record<string, string> = {
  queued: "等待处理",
  running: "处理中",
  paused: "已暂停",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  superseded: "已替代",
  waiting: "等待处理",
  warming: "估算中",
  stalled: "暂未取得新进度",
  active: "可用",
  building: "构建中",
  retired: "已退役",
};
function resultLabel(value: string) {
  const names: Record<string, string> = {
    succeeded: "检索成功",
    partial: "部分覆盖",
    unavailable: "暂不可用",
    empty: "没有结果",
    hybrid: "混合检索",
    keyword: "关键词检索",
  };
  return names[value] ?? value;
}
function stateName(value: string) {
  return stateNames[value] ?? value;
}
function localTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : "不限";
}
function remainingTime(seconds: number) {
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60
    ? `${minutes} 分钟`
    : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
const poller = new ProgressPoller({
  enabled: () =>
    alive &&
    panelOpen &&
    !document.hidden &&
    !busy.value &&
    props.mode !== "settings" &&
    (props.mode !== "chat" || !!chatId.value) &&
    jobs.value.some((j) => ["queued", "running"].includes(j.status)),
  load: async () => {
    const path =
      props.mode === "chat"
        ? `/api/v1/chats/${chatId.value}/memory`
        : "/api/v1/memory";
    const [page, state, detail] = await Promise.all([
      apiPageRequest<Job[]>(jobsPath()),
      props.mode === "chat"
        ? apiRequest<typeof chat>(path)
        : Promise.resolve(null),
      selectedJob.value
        ? apiRequest<Job>(`/api/v1/memory/jobs/${selectedJob.value.id}`)
        : Promise.resolve(null),
    ]);
    return { page, state, detail };
  },
  apply: ({ page, state, detail }) => {
    jobs.value = page.data;
    nextJobCursor.value = page.page.nextCursor;
    selectedJob.value = detail;
    if (state) Object.assign(chat, state);
    progressError.value = false;
  },
  failed: () => {
    progressError.value = true;
  },
});
let epoch = 0;
let alive = true;
let pendingChatRefresh = false;
let requestKey = crypto.randomUUID();
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  epoch++;
  poller.invalidate();
  busy.value = true;
  error.value = "";
  const token = epoch;
  try {
    await action();
  } catch (e) {
    if (alive && token === epoch) error.value = errorMessage(e);
  } finally {
    if (alive) {
      busy.value = false;
      if (pendingChatRefresh) {
        pendingChatRefresh = false;
        void run(refresh);
      }
    }
  }
}
async function refresh() {
  const token = epoch;
  const value = await apiRequest<Settings>("/api/v1/ai/memory/settings");
  if (!alive || token !== epoch) return;
  settings.value = value;
  generationId.value =
    value.generations.find((g) => g.status === "building")?.id ??
    value.generations.find((g) => g.status === "active")?.id ??
    "";
  if (props.mode === "jobs" || (props.mode === "chat" && chatId.value)) {
    await loadJobPage();
    if (props.mode === "chat") {
      const state = await apiRequest<typeof chat>(
        `/api/v1/chats/${chatId.value}/memory`,
      );
      if (alive && token === epoch) Object.assign(chat, state);
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
        ...(searchFrom.value
          ? { from: new Date(searchFrom.value).toISOString() }
          : {}),
        ...(searchTo.value
          ? { to: new Date(searchTo.value).toISOString() }
          : {}),
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
  resetJobPage();
  notice.value = "补建任务已创建，可在下方任务列表查看进度。";
  await refresh();
}
async function action(job: Job, name: string) {
  if (!session.sensitiveActive) return;
  await apiRequest(`/api/v1/memory/jobs/${job.id}/actions`, {
    method: "POST",
    body: jsonBody({ action: name, expectedVersion: job.version }),
  });
  notice.value = "任务操作已完成。";
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
  resetJobPage();
  jobs.value = [];
  chat.coverage = null;
  chat.enabled = false;
  chat.version = 0;
  epoch++;
  poller.invalidate();
  result.value = null;
  source.value = "";
  query.value = "";
  searchFrom.value = "";
  searchTo.value = "";
  requestKey = crypto.randomUUID();
  if (busy.value) pendingChatRefresh = true;
  else void run(refresh);
});
watch(
  () => session.sensitiveActive,
  (active) => {
    if (!active) {
      epoch++;
      poller.invalidate();
      result.value = null;
      source.value = "";
      query.value = "";
      secret.value = "";
    }
  },
);
function onToggle(event: Event) {
  panelOpen = event.target instanceof HTMLDetailsElement && event.target.open;
  if (panelOpen) void poller.tick();
  if (event.target instanceof HTMLDetailsElement && !event.target.open) {
    epoch++;
    poller.invalidate();
    result.value = null;
    source.value = "";
    query.value = "";
    secret.value = "";
  }
}
onMounted(() => {
  void run(refresh);
  poller.start();
});
onBeforeUnmount(() => {
  alive = false;
  poller.stop();
  epoch++;
  poller.invalidate();
  result.value = null;
  source.value = "";
  secret.value = "";
});
</script>
<template>
  <component
    :is="embedded ? 'section' : 'details'"
    class="memory-panel"
    :class="{ 'admin-panel': embedded }"
    :open="!embedded && mode === 'settings'"
    @toggle="onToggle"
  >
    <div v-if="embedded" class="panel-head">
      <div>
        <p class="card-kicker">
          {{ mode === "jobs" ? "HISTORY INDEX" : "CHAT MEMORY" }}
        </p>
        <h2>
          {{
            mode === "settings"
              ? "长期聊天检索设置"
              : mode === "chat"
                ? "聊天长期记忆"
                : "历史索引任务"
          }}
        </h2>
      </div>
      <button
        class="button secondary"
        type="button"
        :disabled="busy"
        @click="run(refresh)"
      >
        <RefreshCw :size="18" />{{ busy ? "刷新中…" : "刷新" }}
      </button>
    </div>
    <summary v-if="!embedded">
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
    <SensitiveUnlock v-if="!embedded || mode === 'settings'" />
    <DismissibleMessage
      v-if="error && !selectedJob"
      error
      @close="error = ''"
      >{{ error }}</DismissibleMessage
    >
    <DismissibleMessage
      v-else-if="notice && !selectedJob"
      @close="notice = ''"
      >{{ notice }}</DismissibleMessage
    >
    <button
      v-if="!embedded"
      class="button secondary"
      :disabled="busy"
      @click="run(refresh)"
    >
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
        <h3>历史补建</h3>
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
                {{ g.model }} · {{ stateName(g.status) }}
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
        </fieldset>
        <h3>检索测试</h3>
        <fieldset
          :disabled="
            busy ||
            !session.sensitiveActive ||
            !chat.enabled ||
            !settings?.enabled
          "
        >
          <label
            >检索开始时间（可选）<input
              v-model="searchFrom"
              type="datetime-local"
          /></label>
          <label
            >检索结束时间（可选）<input
              v-model="searchTo"
              type="datetime-local"
          /></label>
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
          <h3>检索测试结果</h3>
          <p>
            {{ resultLabel(result.status) }} ·
            {{ resultLabel(result.retrievalMode) }}
          </p>
          <p v-if="!result.evidence.length">没有找到匹配的历史来源。</p>
          <article v-for="item in result.evidence" :key="item.ref">
            <button
              class="button"
              :disabled="busy"
              @click="run(() => viewSource(item.ref))"
            >
              查看来源 {{ item.ref }}
            </button>
            <p>
              {{ item.text.slice(0, 200)
              }}{{ item.text.length > 200 ? "…" : "" }}
            </p>
          </article>
        </div>
        <AdminDetailDialog
          v-if="source && session.sensitiveActive"
          title="历史来源原文"
          @close="source = ''"
        >
          <pre>{{ source }}</pre>
        </AdminDetailDialog>
      </template>
    </div>
    <div v-if="mode !== 'settings'" class="memory-jobs">
      <p v-if="progressError" role="status">
        连接异常，显示最后一次获取的进度，将自动重试。
      </p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>聊天 / 任务</th>
              <th>状态</th>
              <th>处理进度</th>
              <th>预计完成</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="job in jobs" :key="job.id">
              <td>
                {{ job.chat_name || job.chat_id
                }}<small>{{ jobKind(job) }} · {{ job.model }}</small>
              </td>
              <td>
                <span class="state-badge">{{
                  stateName(
                    job.status === "queued" &&
                      ["available", "warming", "stalled"].includes(
                        job.progress?.estimate.status ?? "",
                      )
                      ? "running"
                      : job.status,
                  )
                }}</span>
              </td>
              <td v-if="job.progress?.scope">
                {{ job.progress.processed }} / {{ job.progress.total }} 条 ·
                {{ job.progress.percent?.toFixed(1) }}%<small
                  v-if="job.progress.removed"
                  >已移除 {{ job.progress.removed }} 条</small
                >
              </td>
              <td v-else>
                {{
                  job.reason === "incremental" && !job.request_key
                    ? "增量任务，不统计百分比"
                    : "未记录进度统计"
                }}
              </td>
              <td>
                {{
                  !progressError &&
                  job.progress?.estimate.status === "available"
                    ? localTime(job.progress.estimate.estimatedCompletionAt)
                    : stateName(job.progress?.estimate.status ?? job.status)
                }}
              </td>
              <td>{{ localTime(job.created_at) }}</td>
              <td>
                <button
                  class="button tiny secondary"
                  :disabled="busy"
                  @click="
                    ((event) => {
                      const trigger = event.currentTarget;
                      run(() => showJob(job, trigger));
                    })($event)
                  "
                >
                  详情
                </button>
              </td>
            </tr>
            <tr v-if="!jobs.length">
              <td colspan="6">{{ busy ? "正在加载任务…" : "暂无索引任务" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <CursorPagination
        :page="jobPage"
        :item-count="jobs.length"
        :busy="busy"
        :has-previous="jobPage > 1"
        :has-next="!!nextJobCursor"
        @previous="run(() => turnJobPage(-1))"
        @next="run(() => turnJobPage(1))"
      />
      <AdminDetailDialog
        v-if="selectedJob"
        title="历史索引任务详情"
        :return-focus="jobTrigger"
        @close="closeJob"
      >
        <DismissibleMessage v-if="error" error inline @close="error = ''">{{
          error
        }}</DismissibleMessage>
        <DismissibleMessage v-else-if="notice" inline @close="notice = ''">{{
          notice
        }}</DismissibleMessage>
        <article v-for="job in selectedJob ? [selectedJob] : []" :key="job.id">
          <h4>
            {{ job.chat_name || "聊天" }} · {{ jobKind(job) }} ·
            {{
              stateName(
                job.status === "queued" &&
                  ["available", "warming", "stalled"].includes(
                    job.progress?.estimate.status ?? "",
                  )
                  ? "running"
                  : job.status,
              )
            }}
          </h4>
          <p>
            {{ job.model }} · {{ localTime(job.range_from) }} —
            {{ localTime(job.range_to) }}
          </p>
          <template v-if="job.progress?.scope">
            <p v-if="job.progress.scope === 'remaining'">升级后剩余任务进度</p>
            <progress
              :value="job.progress.percent ?? 0"
              max="100"
              aria-label="任务处理进度"
            ></progress>
            <p>
              已处理 {{ job.progress.processed }} / {{ job.progress.total }} 条
              · {{ (job.progress.percent ?? 0).toFixed(1) }}%
            </p>
            <p>
              剩余 {{ job.progress.remaining }} 条<span
                v-if="job.progress.removed"
              >
                · 已移除 {{ job.progress.removed }} 条（不计为索引成功）</span
              >
            </p>
            <template
              v-if="
                job.progress.estimate.status === 'available' && !progressError
              "
            >
              <p>
                最近速度约
                {{ job.progress.estimate.messagesPerMinute?.toFixed(1) }}
                条/分钟
              </p>
              <p>
                预计剩余约
                {{ remainingTime(job.progress.estimate.remainingSeconds ?? 0) }}
                · 预计完成
                {{ localTime(job.progress.estimate.estimatedCompletionAt) }}
              </p>
              <small>根据近期速度估算，会随模型负载变化。</small>
            </template>
            <p v-else>
              {{
                progressError
                  ? "连接异常，预估暂不可用"
                  : stateName(job.progress.estimate.status)
              }}
            </p>
            <small>更新于 {{ localTime(job.progress.generatedAt) }}</small>
          </template>
          <p v-else>
            {{
              job.reason !== "incremental" || job.request_key
                ? "未记录进度统计"
                : "增量任务，不统计百分比"
            }}
          </p>
          <p>任务 ID：{{ job.id }}</p>
          <p>
            创建于 {{ localTime(job.created_at) }} · 更新于
            {{ localTime(job.updated_at) }} · 当前批次尝试 {{ job.attempts }} 次
          </p>
          <p>索引代次：{{ job.generation_id }}</p>
          <p v-if="job.error_code">{{ job.error_code }}</p>
          <details>
            <summary>诊断信息</summary>
            处理游标 {{ job.cursor_index }} /
            {{ job.through_index }}（不是消息数量）
          </details>
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
            v-if="
              ['queued', 'running', 'paused', 'failed'].includes(job.status)
            "
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
      </AdminDetailDialog>
    </div>
  </component>
</template>
<style scoped>
.memory-panel:not(.admin-panel) {
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
  min-width: 0;
}
.memory-jobs td small {
  display: block;
  color: #64748b;
  margin-top: 0.35rem;
}
.memory-jobs .table-scroll {
  overflow-x: auto;
}
.memory-jobs progress {
  width: min(100%, 36rem);
  height: 0.75rem;
  accent-color: #3279c4;
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
