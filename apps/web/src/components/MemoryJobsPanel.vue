<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RefreshCw } from "@lucide/vue";
import { confirmAction } from "../services/confirm";
import {
  apiPageRequest,
  apiRequest,
  errorMessage,
  jsonBody,
} from "../services/api";
import { ProgressPoller } from "../services/progress-poller";
import { useSessionStore } from "../stores/session";
import { formatDateTime } from "../utils/format";
import {
  isProminentJob,
  memoryErrorText,
  memoryJobKind,
  memoryJobStatus,
  type MemoryJob,
} from "../utils/memory-health";
import { enumLabel, statusLabel } from "../utils/status-labels";
import AdminDetailDialog from "./AdminDetailDialog.vue";
import CursorPagination from "./CursorPagination.vue";
import DismissibleMessage from "./DismissibleMessage.vue";
import LockedHint from "./LockedHint.vue";
import StatusBadge from "./StatusBadge.vue";

/**
 * Index jobs (R10): 补全历史 / 归属重建 and anything failed, waiting for a
 * retry or running are shown; routine 新消息 jobs collapse into one line.
 */
const props = defineProps<{
  /** Limit to one chat (chat dialog); otherwise all chats. */
  chatId?: string;
  /** Standalone admin panel with its own heading (AI 服务页). */
  embedded?: boolean;
  /** Bump to reload after an action elsewhere (enable, repair). */
  reloadToken?: number;
}>();
const session = useSessionStore();
const busy = ref(false);
const error = ref("");
const notice = ref("");
const jobs = ref<MemoryJob[]>([]);
const showIncremental = ref(false);
const selectedJob = ref<MemoryJob | null>(null);
const jobTrigger = ref<HTMLElement | null>(null);
const page = ref(1);
const cursors = ref<Array<string | null>>([null]);
const nextCursor = ref<string | null>(null);
const progressError = ref(false);
let epoch = 0;
let alive = true;

const visibleJobs = computed(() =>
  showIncremental.value ? jobs.value : jobs.value.filter(isProminentJob),
);
const hiddenCount = computed(
  () => jobs.value.length - jobs.value.filter(isProminentJob).length,
);

function jobsPath() {
  const base = props.chatId
    ? `/api/v1/chats/${props.chatId}/memory/jobs`
    : "/api/v1/memory/jobs";
  const params = new URLSearchParams({ limit: props.chatId ? "20" : "50" });
  const cursor = cursors.value[page.value - 1];
  if (cursor) params.set("cursor", cursor);
  return `${base}?${params}`;
}
async function fetchAll() {
  const [result, detail] = await Promise.all([
    apiPageRequest<MemoryJob[]>(jobsPath()),
    selectedJob.value
      ? apiRequest<MemoryJob>(`/api/v1/memory/jobs/${selectedJob.value.id}`)
      : Promise.resolve(null),
  ]);
  return { result, detail };
}
function apply({ result, detail }: Awaited<ReturnType<typeof fetchAll>>) {
  jobs.value = result.data;
  nextCursor.value = result.page.nextCursor;
  selectedJob.value = detail;
  progressError.value = false;
}
const poller = new ProgressPoller({
  enabled: () =>
    alive &&
    !document.hidden &&
    !busy.value &&
    jobs.value.some((j) => ["queued", "running"].includes(j.status)),
  load: fetchAll,
  apply,
  failed: () => {
    progressError.value = true;
  },
});
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  epoch++;
  poller.invalidate();
  busy.value = true;
  error.value = "";
  const token = epoch;
  try {
    await action();
  } catch (cause) {
    if (alive && token === epoch) error.value = errorMessage(cause);
  } finally {
    if (alive) busy.value = false;
  }
}
async function refresh() {
  const token = epoch;
  const value = await fetchAll();
  if (alive && token === epoch) apply(value);
}
async function turnPage(direction: number) {
  const previousPage = page.value;
  const previousCursors = [...cursors.value];
  if (direction > 0 && nextCursor.value) {
    cursors.value = cursors.value.slice(0, page.value);
    cursors.value.push(nextCursor.value);
    page.value++;
  } else if (direction < 0 && page.value > 1) page.value--;
  selectedJob.value = null;
  try {
    await refresh();
  } catch (cause) {
    page.value = previousPage;
    cursors.value = previousCursors;
    throw cause;
  }
}
async function showJob(job: MemoryJob, trigger: EventTarget | null) {
  jobTrigger.value = trigger instanceof HTMLElement ? trigger : null;
  const token = epoch;
  const detail = await apiRequest<MemoryJob>(`/api/v1/memory/jobs/${job.id}`);
  if (alive && token === epoch) selectedJob.value = detail;
}
function closeJob() {
  epoch++;
  selectedJob.value = null;
  poller.invalidate();
}
const confirmations: Record<
  string,
  { title: string; message: string; confirmText: string; danger: boolean }
> = {
  cancel: {
    title: "取消索引任务？",
    message:
      "已写入的向量保留，未处理的部分不会继续；之后可在长期检索状态中点击“修复”补齐。",
    confirmText: "取消任务",
    danger: true,
  },
};
async function action(job: MemoryJob, name: "pause" | "resume" | "cancel") {
  if (!session.sensitiveActive) return session.requestUnlock();
  const confirmation = confirmations[name];
  if (
    confirmation &&
    !(await confirmAction(confirmation.message, confirmation))
  )
    return;
  await apiRequest(`/api/v1/memory/jobs/${job.id}/actions`, {
    method: "POST",
    body: jsonBody({ action: name, expectedVersion: job.version }),
  });
  notice.value = "任务操作已完成。";
  await refresh();
}

function kindName(job: MemoryJob) {
  return enumLabel("memoryJobKind", memoryJobKind(job));
}
function statusName(job: MemoryJob) {
  return statusLabel("memoryJob", memoryJobStatus(job)).label;
}
function retryText(job: MemoryJob) {
  if (memoryJobStatus(job) !== "waiting-retry") return "";
  return job.next_attempt_at
    ? `下次自动重试 ${formatDateTime(job.next_attempt_at)}`
    : "将自动重试";
}
const estimateNames: Record<string, string> = {
  waiting: "等待处理",
  warming: "估算中",
  stalled: "暂未取得新进度",
};
function estimateText(job: MemoryJob) {
  const status = memoryJobStatus(job);
  if (status === "waiting-retry") return retryText(job);
  if (
    !progressError.value &&
    job.progress?.estimate.status === "available" &&
    job.progress.estimate.estimatedCompletionAt
  )
    return formatDateTime(job.progress.estimate.estimatedCompletionAt);
  if (["queued", "running"].includes(status))
    return estimateNames[job.progress?.estimate.status ?? ""] ?? "等待处理";
  return "—";
}
function remainingTime(seconds: number) {
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60
    ? `${minutes} 分钟`
    : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

watch(
  () => [props.chatId, props.reloadToken],
  () => {
    page.value = 1;
    cursors.value = [null];
    nextCursor.value = null;
    selectedJob.value = null;
    void run(refresh);
  },
);
onMounted(() => {
  void run(refresh);
  poller.start();
});
onBeforeUnmount(() => {
  alive = false;
  poller.stop();
});
</script>

<template>
  <component
    :is="embedded ? 'section' : 'div'"
    class="memory-jobs"
    :class="{ 'admin-panel': embedded }"
  >
    <div v-if="embedded" class="panel-head">
      <div>
        <p class="card-kicker">索引任务</p>
        <h2>索引任务</h2>
      </div>
      <button
        class="button secondary"
        type="button"
        :disabled="busy"
        @click="run(refresh)"
      >
        <RefreshCw :size="16" />{{ busy ? "刷新中…" : "刷新" }}
      </button>
    </div>
    <p v-if="embedded" class="panel-description">
      补全历史和归属重建由启用聊天、一键修复和切换模型自动创建；向量服务故障时任务转为“等待重试”，按
      5、15、60 分钟退避自动重试，最长 24 小时。
    </p>
    <DismissibleMessage
      v-if="error && !selectedJob"
      error
      inline
      @close="error = ''"
      >{{ error }}</DismissibleMessage
    >
    <DismissibleMessage
      v-else-if="notice && !selectedJob"
      inline
      @close="notice = ''"
      >{{ notice }}</DismissibleMessage
    >
    <p v-if="progressError" class="panel-description" role="status">
      连接异常，显示最后一次获取的进度，将自动重试。
    </p>
    <div class="memory-jobs-filter">
      <span class="panel-description">
        {{
          hiddenCount && !showIncremental
            ? `已折叠本页 ${hiddenCount} 个新消息任务（已完成或排队中）。`
            : showIncremental
              ? "正在显示全部任务，包括新消息任务。"
              : "本页没有可折叠的新消息任务。"
        }}
      </span>
      <button
        v-if="hiddenCount || showIncremental"
        class="button tiny secondary"
        type="button"
        :aria-pressed="showIncremental"
        @click="showIncremental = !showIncremental"
      >
        {{ showIncremental ? "隐藏新消息任务" : "显示新消息任务" }}
      </button>
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{{ chatId ? "任务" : "聊天 / 任务" }}</th>
            <th>状态</th>
            <th>处理进度</th>
            <th>预计完成 / 重试</th>
            <th>创建时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in visibleJobs" :key="job.id">
            <td>
              <template v-if="chatId">{{ kindName(job) }}</template>
              <template v-else>{{ job.chat_name || job.chat_id }}</template
              ><small
                >{{ chatId ? "" : `${kindName(job)} · ` }}{{ job.model }}</small
              >
            </td>
            <td>
              <StatusBadge domain="memoryJob" :status="memoryJobStatus(job)" />
              <small v-if="job.error_code">{{
                memoryErrorText(job.error_code, job.error_detail)
              }}</small>
            </td>
            <td v-if="job.progress?.scope">
              {{ job.progress.processed }} / {{ job.progress.total }} 条 ·
              {{ (job.progress.percent ?? 0).toFixed(1) }}%<small
                v-if="job.progress.removed"
                >已移除 {{ job.progress.removed }} 条</small
              >
            </td>
            <td v-else>
              {{
                memoryJobKind(job) === "incremental"
                  ? "新消息，不统计百分比"
                  : "尚未开始统计"
              }}
            </td>
            <td>{{ estimateText(job) }}</td>
            <td>{{ formatDateTime(job.created_at) }}</td>
            <td>
              <button
                class="button tiny secondary"
                type="button"
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
          <tr v-if="!visibleJobs.length">
            <td colspan="6">
              {{
                busy
                  ? "正在加载任务…"
                  : jobs.length
                    ? "本页只有已完成或排队中的新消息任务。"
                    : "暂无索引任务"
              }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <CursorPagination
      :page="page"
      :item-count="jobs.length"
      :busy="busy"
      :has-previous="page > 1"
      :has-next="!!nextCursor"
      @previous="run(() => turnPage(-1))"
      @next="run(() => turnPage(1))"
    />
    <AdminDetailDialog
      v-if="selectedJob"
      title="索引任务详情"
      size="md"
      :return-focus="jobTrigger"
      @close="closeJob"
    >
      <DismissibleMessage v-if="error" error inline @close="error = ''">{{
        error
      }}</DismissibleMessage>
      <DismissibleMessage v-else-if="notice" inline @close="notice = ''">{{
        notice
      }}</DismissibleMessage>
      <article
        v-for="job in selectedJob ? [selectedJob] : []"
        :key="job.id"
        class="memory-job-detail"
      >
        <h4>
          {{ job.chat_name || "聊天" }} · {{ kindName(job) }} ·
          {{ statusName(job) }}
        </h4>
        <p>
          {{ job.model
          }}<template v-if="job.range_from || job.range_to">
            · {{ formatDateTime(job.range_from, "不限") }} —
            {{ formatDateTime(job.range_to, "不限") }}</template
          >
        </p>
        <template v-if="job.progress?.scope">
          <progress
            :value="job.progress.percent ?? 0"
            max="100"
            aria-label="任务处理进度"
          ></progress>
          <p>
            已处理 {{ job.progress.processed }} / {{ job.progress.total }} 条 ·
            {{ (job.progress.percent ?? 0).toFixed(1) }}%
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
              条/分钟 · 预计剩余约
              {{ remainingTime(job.progress.estimate.remainingSeconds ?? 0) }}
            </p>
            <small>根据近期速度估算，会随模型负载变化。</small>
          </template>
          <small v-else-if="progressError">连接异常，预估暂不可用</small>
        </template>
        <p v-else>
          {{
            memoryJobKind(job) === "incremental"
              ? "新消息任务，不统计百分比。"
              : "尚未开始统计进度。"
          }}
        </p>
        <p v-if="retryText(job)">{{ retryText(job) }}</p>
        <p v-if="job.error_code">
          最近错误：{{
            memoryErrorText(
              job.error_code,
              job.error_detail,
              typeof job.error_detail?.at === "string"
                ? job.error_detail.at
                : null,
            )
          }}
        </p>
        <p class="keyline">
          创建于 {{ formatDateTime(job.created_at) }} · 更新于
          {{ formatDateTime(job.updated_at) }} · 当前批次尝试
          {{ job.attempts }} 次
        </p>
        <details class="keyline">
          <summary>诊断信息</summary>
          任务 ID {{ job.id }} · 索引代次 {{ job.generation_id }} · 处理游标
          {{ job.cursor_index }} / {{ job.through_index }}（不是消息数量）
        </details>
        <div class="row-actions">
          <button
            v-if="['queued', 'running'].includes(job.status)"
            class="button secondary"
            :disabled="busy || !session.sensitiveActive"
            @click="run(() => action(job, 'pause'))"
          >
            暂停
          </button>
          <button
            v-if="['paused', 'failed'].includes(job.status)"
            class="button secondary"
            :disabled="busy || !session.sensitiveActive"
            @click="run(() => action(job, 'resume'))"
          >
            恢复
          </button>
          <button
            v-if="
              ['queued', 'running', 'paused', 'failed'].includes(job.status)
            "
            class="button danger-ghost"
            :disabled="busy || !session.sensitiveActive"
            @click="run(() => action(job, 'cancel'))"
          >
            取消
          </button>
          <LockedHint compact reason="操作任务需要敏感操作授权" />
        </div>
      </article>
    </AdminDetailDialog>
  </component>
</template>

<style scoped>
.memory-jobs {
  min-width: 0;
}
.memory-jobs td small {
  display: block;
  margin-top: 0.35rem;
  color: var(--bubblepilot-muted);
}
.table-scroll {
  overflow-x: auto;
}
.memory-jobs-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-block: 10px;
}
.memory-jobs-filter .panel-description {
  margin: 0;
}
.memory-job-detail {
  display: grid;
  gap: 6px;
}
.memory-job-detail p,
.memory-job-detail h4 {
  margin: 0;
}
.memory-job-detail progress {
  width: min(100%, 36rem);
  height: 0.75rem;
  accent-color: var(--bubblepilot-accent);
}
</style>
