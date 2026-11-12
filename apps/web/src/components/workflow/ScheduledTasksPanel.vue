<script setup lang="ts">
import TaskScheduleEditor from "./TaskScheduleEditor.vue";
import type { TaskSchedule } from "../../../../../modules/scheduled-tasks/task-schedule";
import AdminFormDialog from "../AdminFormDialog.vue";
import AdminDetailDialog from "../AdminDetailDialog.vue";
import {
  CalendarClock,
  MessageSquare,
  History,
  Play,
  Save,
  RefreshCw,
} from "@lucide/vue";
import { useSessionStore } from "../../stores/session";
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { apiRequest, apiAllPages, errorMessage } from "../../services/api";
// A compact excerpt, not a generated title; the stored task remains unchanged.
function taskOverview(content: string | null): string {
  if (content === null) return "内容已清理";
  const text = content.trim();
  if (!text) return "暂无任务内容";
  const opening = text.match(/^[^\n。！？]+[。！？]?/u)?.[0] ?? text;
  const characters = Array.from(opening.replace(/\s+/gu, " ").trim());
  return (
    characters.slice(0, 56).join("") +
    (characters.length > 56 || opening.length < text.length ? "…" : "")
  );
}
const settingsDialog = ref(false);
const settingsOriginal = ref<Settings | null>(null);
function openSettings() {
  settingsOriginal.value = settings.value ? { ...settings.value } : null;
  settingsDialog.value = true;
}
function closeSettings() {
  if (settingsOriginal.value) settings.value = { ...settingsOriginal.value };
  settingsDialog.value = false;
}
interface Task {
  id: string;
  summary?: string | null;
  content: string | null;
  scheduledAt: string;
  timeZone: string;
  status: string;
  version: number;
  schedule?: TaskSchedule;
  lifecycle?: string;
  scheduleSummary?: string;
  upcoming?: string[];
  consumedCount?: number;
  sendingAlreadyStarted?: boolean;
  chatName: string | null;
  chatId: string;
  workflowName: string;
  creatorSenderId: string;
}
interface TaskDetail {
  summary?: Task;
  hasMore?: boolean;
  occurrences?: Array<{
    id: string;
    occurrence_number: string;
    scheduled_at: string;
    status: string;
    reason_code: string | null;
    execution_id: string | null;
  }>;
  task: {
    summary?: string | null;
    content: string | null;
    request_snapshot: string | null;
    status: string;
    scheduled_at: string;
    timezone: string;
    creator_sender_id: string;
  };
  events: Array<{
    id: string;
    event_type: string;
    created_at: string;
    reason_code: string | null;
  }>;
  runs: Array<{
    id: string;
    execution_id: string;
    generation_mode: string | null;
    accepted_at: string;
    outcome: string | null;
    reason_code: string | null;
  }>;
}
interface Settings {
  paused: boolean;
  pending_limit: number;
  catchup_minutes: number;
  version: number;
}
const items = ref<Task[]>([]),
  workflows = ref<Array<{ id: string; name: string }>>([]),
  chats = ref<Array<{ id: string; displayName: string | null }>>([]);
const workflowId = ref(""),
  chatId = ref(""),
  status = ref(""),
  offset = ref(0),
  hasMore = ref(false),
  busy = ref(false),
  mutating = ref(false),
  error = ref(""),
  detail = ref<TaskDetail | null>(null),
  detailTask = ref<Task | null>(null),
  editing = ref<Task | null>(null),
  content = ref(""),
  summary = ref(""),
  settings = ref<Settings | null>(null);
const session = useSessionStore();
watch(
  () => session.sensitiveActive,
  (active) => {
    if (!active) {
      detail.value = null;
      editing.value = null;
    }
  },
);
let generation = 0;
const labels: Record<string, string> = {
  pending: "待执行",
  running: "执行中",
  sent: "已发送",
  cancelled: "已取消",
  expired: "已过期",
  failed: "失败",
  delivery_unknown: "发送结果未知",
  paused: "已暂停",
  completed: "已完成",
  skipped: "已跳过",
};
const taskLabels = Object.fromEntries(
  Object.entries(labels).filter(([key]) => key !== "skipped"),
);
function eventLabel(type: string) {
  return (
    (
      {
        created: "创建",
        "summary-updated": "更新概要",
        updated: "修改",
        update: "修改",
        cancel: "取消",
        pause: "暂停",
        resume: "恢复",
        skip: "跳过下一次",
        "missed-occurrences": "错过周期",
        accepted: "到期受理",
        ...labels,
      } as Record<string, string>
    )[type] ?? type
  );
}
async function load() {
  const ticket = ++generation;
  busy.value = true;
  error.value = "";
  try {
    const query = new URLSearchParams({
      offset: String(offset.value),
      limit: "20",
    });
    if (workflowId.value) query.set("workflowId", workflowId.value);
    if (chatId.value) query.set("chatId", chatId.value);
    if (status.value) query.set("status", status.value);
    const data = await apiRequest<{ items: Task[]; hasMore: boolean }>(
      `/api/v1/scheduled-tasks?${query}`,
    );
    if (ticket !== generation) return;
    items.value = data.items;
    hasMore.value = data.hasMore;
  } catch (e) {
    if (ticket === generation) error.value = errorMessage(e);
  } finally {
    if (ticket === generation) busy.value = false;
  }
}
async function action(operation: () => Promise<void>) {
  if (mutating.value) return;
  mutating.value = true;
  error.value = "";
  try {
    await operation();
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    mutating.value = false;
  }
}
const draftSchedule = ref<TaskSchedule>({ kind: "once", scheduledAt: "" });
const draftZone = ref("UTC");
const preview = ref<{ scheduleSummary: string; upcoming: string[] } | null>(
  null,
);
const notice = ref("");
const previewBusy = ref(false);
const previewKey = ref("");
const detailOffset = ref(0);
let previewGeneration = 0;
function scheduleKey() {
  return JSON.stringify({
    schedule: draftSchedule.value,
    timeZone: draftZone.value,
    consumedCount: editing.value?.consumedCount ?? 0,
  });
}
watch(
  [draftSchedule, draftZone],
  () => {
    preview.value = null;
    previewKey.value = "";
    previewGeneration++;
    previewBusy.value = false;
  },
  { deep: true, flush: "sync" },
);
watch(
  editing,
  () => {
    previewGeneration++;
    previewBusy.value = false;
  },
  { flush: "sync" },
);
function edit(task: Task) {
  error.value = "";
  detail.value = null;
  editing.value = task;
  content.value = task.content ?? "";
  summary.value = task.summary ?? "";
  draftSchedule.value = JSON.parse(
    JSON.stringify(
      task.schedule ?? { kind: "once", scheduledAt: task.scheduledAt },
    ),
  ) as TaskSchedule;
  draftZone.value = task.timeZone;
  preview.value = {
    scheduleSummary: task.scheduleSummary ?? "单次提醒",
    upcoming: task.upcoming ?? [task.scheduledAt],
  };
  previewKey.value = scheduleKey();
}
async function previewSchedule() {
  const ticket = ++previewGeneration;
  const key = scheduleKey();
  previewBusy.value = true;
  error.value = "";
  try {
    const result = await apiRequest<{
      scheduleSummary: string;
      upcoming: string[];
    }>("/api/v1/scheduled-tasks/preview", { method: "POST", body: key });
    if (ticket === previewGeneration && editing.value) {
      preview.value = result;
      previewKey.value = key;
    }
  } catch (e) {
    if (ticket === previewGeneration) error.value = errorMessage(e);
  } finally {
    if (ticket === previewGeneration) previewBusy.value = false;
  }
}
async function save() {
  if (!editing.value || previewKey.value !== scheduleKey()) return;
  const task = editing.value;
  const changed =
    JSON.stringify(draftSchedule.value) !==
      JSON.stringify(
        task.schedule ?? { kind: "once", scheduledAt: task.scheduledAt },
      ) || draftZone.value !== task.timeZone;
  if (
    !changed &&
    content.value === task.content &&
    (!summary.value.trim() || summary.value.trim() === task.summary)
  ) {
    editing.value = null;
    return;
  }
  await action(async () => {
    await apiRequest(`/api/v1/scheduled-tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedVersion: task.version,
        ...(content.value !== task.content ? { content: content.value } : {}),
        ...(summary.value.trim() && summary.value.trim() !== task.summary
          ? { summary: summary.value.trim() }
          : {}),
        ...(changed
          ? { schedule: draftSchedule.value, timeZone: draftZone.value }
          : {}),
      }),
    });
    editing.value = null;
  });
}
async function control(
  task: Task,
  operation: "pause" | "resume" | "skip-next",
) {
  await action(async () => {
    const result = await apiRequest<Task>(
      `/api/v1/scheduled-tasks/${task.id}/${operation}`,
      {
        method: "POST",
        body: JSON.stringify({ expectedVersion: task.version }),
      },
    );
    notice.value = result.sendingAlreadyStarted
      ? "未来周期已更新；本次发送已经提交，仍可能送达，最终结果请查看详情。"
      : "操作成功。";
  });
}
async function cancel(task: Task) {
  await action(async () => {
    const result = await apiRequest<Task>(
      `/api/v1/scheduled-tasks/${task.id}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ expectedVersion: task.version }),
      },
    );
    notice.value = result.sendingAlreadyStarted
      ? "未来周期已更新；本次发送已经提交，仍可能送达，最终结果请查看详情。"
      : "操作成功。";
  });
}
async function inspect(task: Task, page = 0) {
  detailOffset.value = page;
  await action(async () => {
    const value = await apiRequest<TaskDetail>(
      `/api/v1/scheduled-tasks/${task.id}?offset=${page}&limit=20`,
    );
    if (session.sensitiveActive) {
      detail.value = value;
      detailTask.value = task;
    }
  });
}
async function saveSettings() {
  if (!settings.value) return;
  await action(async () => {
    const s = settings.value!;
    settings.value = await apiRequest("/api/v1/settings/scheduled-tasks", {
      method: "PUT",
      body: JSON.stringify({
        paused: s.paused,
        pendingLimit: s.pending_limit,
        catchupMinutes: s.catchup_minutes,
        expectedVersion: s.version,
      }),
    });
    settingsOriginal.value = settings.value ? { ...settings.value } : null;
    settingsDialog.value = false;
  });
}
watch([workflowId, chatId, status], () => {
  offset.value = 0;
  void load();
});
onMounted(async () => {
  void load();
  const result = await Promise.allSettled([
    apiRequest<Array<{ id: string; name: string }>>("/api/v1/workflows"),
    apiAllPages<{ id: string; displayName: string | null }>(
      "/api/v1/chats?limit=100",
    ),
    apiRequest<Settings>("/api/v1/settings/scheduled-tasks"),
  ]);
  if (result[0].status === "fulfilled") workflows.value = result[0].value;
  if (result[1].status === "fulfilled") chats.value = result[1].value;
  if (result[2].status === "fulfilled") settings.value = result[2].value;
});
onBeforeUnmount(() => generation++);
</script>
<template>
  <section class="admin-panel scheduled-tasks">
    <p v-if="notice" role="status">{{ notice }}</p>
    <header class="scheduled-tasks-heading">
      <div>
        <p class="eyebrow">SCHEDULED TASKS</p>
        <h2>定时任务</h2>
        <p>
          按聊天和角色登记的单次与周期提醒。修改、暂停、跳过及取消需要敏感验证。
        </p>
      </div>
      <button
        class="button secondary scheduled-tasks-refresh"
        type="button"
        :disabled="busy || mutating"
        @click="load"
      >
        <RefreshCw :size="16" :class="{ 'button-spinner': busy }" />
        {{ busy ? "刷新中…" : "刷新" }}
      </button>
    </header>
    <div class="task-filters">
      <label
        >工作流<select v-model="workflowId">
          <option value="">全部工作流</option>
          <option v-for="w in workflows" :key="w.id" :value="w.id">
            {{ w.name }}
          </option>
        </select></label
      ><label
        >聊天<select v-model="chatId">
          <option value="">全部聊天</option>
          <option v-for="c in chats" :key="c.id" :value="c.id">
            {{ c.displayName ?? c.id }}
          </option>
        </select></label
      ><label
        >状态<select v-model="status">
          <option value="">全部状态</option>
          <option v-for="(label, key) in taskLabels" :key="key" :value="key">
            {{ label }}
          </option>
        </select></label
      >
    </div>
    <p v-if="!session.sensitiveActive">
      请先在顶部完成敏感验证，才能修改任务或查看详情。
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>任务概要</th>
            <th>工作流 / 聊天</th>
            <th>计划时间</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="task in items" :key="task.id">
            <td>
              <p class="task-summary-excerpt">
                {{ task.summary || taskOverview(task.content) }}
              </p>
              <p class="task-help">{{ task.scheduleSummary ?? "单次提醒" }}</p>
              <small v-if="task.schedule?.kind === 'recurring'"
                >已消耗 {{ task.consumedCount ?? 0 }} 次</small
              >
            </td>
            <td>
              {{ task.workflowName }}<br />{{ task.chatName ?? task.chatId }}
            </td>
            <td>
              {{
                new Date(task.scheduledAt).toLocaleString("zh-CN", {
                  timeZone: task.timeZone,
                })
              }}<br />{{ task.timeZone }}
            </td>
            <td>{{ labels[task.status] ?? task.status }}</td>
            <td>
              <button
                class="button secondary"
                :disabled="mutating || !session.sensitiveActive"
                @click="inspect(task)"
              >
                详情</button
              ><template
                v-if="['pending', 'running', 'paused'].includes(task.status)"
                ><button
                  class="button secondary"
                  :disabled="mutating || !session.sensitiveActive"
                  @click="edit(task)"
                >
                  修改</button
                ><button
                  class="button secondary"
                  :disabled="mutating || !session.sensitiveActive"
                  @click="cancel(task)"
                >
                  取消整个任务
                </button>
                <template v-if="task.schedule?.kind === 'recurring'">
                  <button
                    class="button secondary"
                    :disabled="mutating || !session.sensitiveActive"
                    @click="
                      control(
                        task,
                        task.lifecycle === 'paused' ? 'resume' : 'pause',
                      )
                    "
                  >
                    {{ task.lifecycle === "paused" ? "恢复周期" : "暂停周期" }}
                  </button>
                  <button
                    v-if="task.lifecycle === 'active'"
                    class="button secondary"
                    :disabled="mutating || !session.sensitiveActive"
                    @click="control(task, 'skip-next')"
                  >
                    跳过下一次
                  </button>
                </template></template
              >
            </td>
          </tr>
          <tr v-if="!items.length">
            <td colspan="5">
              {{ busy ? "正在加载…" : "暂无符合条件的任务。" }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <footer>
      <button
        class="button secondary"
        :disabled="busy || offset === 0"
        @click="
          offset = Math.max(0, offset - 20);
          load();
        "
      >
        上一页</button
      ><button
        class="button secondary"
        :disabled="busy || !hasMore"
        @click="
          offset += 20;
          load();
        "
      >
        下一页
      </button>
    </footer>
    <AdminDetailDialog
      v-if="editing"
      title="修改定时任务"
      @close="!mutating && (editing = null)"
    >
      <form
        class="task-dialog-content"
        :aria-busy="mutating"
        @submit.prevent="save"
      >
        <div class="task-context">
          <span>{{ editing.workflowName }}</span
          ><span>{{ editing.chatName ?? editing.chatId }}</span
          ><span class="task-status" :data-status="editing.status">{{
            labels[editing.status]
          }}</span>
        </div>
        <p v-if="error" class="task-alert" role="alert">{{ error }}</p>
        <section class="task-card">
          <label class="task-field"
            >任务概要<input
              v-model="summary"
              maxlength="40"
              :disabled="mutating"
              :required="!!editing.summary"
              placeholder="简短概括核心事项；旧任务未填写时展示正文预览"
          /></label>
          <label class="task-field"
            ><span class="task-field-title"
              ><MessageSquare :size="18" />提醒内容</span
            ><textarea
              v-model="content"
              rows="4"
              maxlength="2000"
              required
              :disabled="mutating"
              placeholder="到点时需要提醒什么？"
            /><span class="task-field-hint"
              ><span>到期后，角色会根据这段内容生成提醒。</span
              ><span>{{ content.length }} / 2000</span></span
            ></label
          >
        </section>
        <section class="task-card">
          <TaskScheduleEditor v-model="draftSchedule" :disabled="mutating" />
          <label class="task-field"
            >提醒时区<input
              v-model="draftZone"
              :disabled="mutating"
              required
              placeholder="Asia/Shanghai"
          /></label>
          <button
            type="button"
            class="button secondary"
            :disabled="previewBusy || mutating"
            @click="previewSchedule"
          >
            {{ previewBusy ? "正在计算…" : "预览未来时间" }}
          </button>
          <div v-if="preview" class="task-timezone">
            <strong>{{ preview.scheduleSummary }}</strong>
            <ol>
              <li v-for="time in preview.upcoming" :key="time">
                {{
                  new Date(time).toLocaleString("zh-CN", {
                    timeZone: draftZone,
                  })
                }}（{{ draftZone }}）
              </li>
            </ol>
            <p v-if="!preview.upcoming.length">没有后续计划时间。</p>
          </div>
          <p v-else class="task-help">
            时间规则修改后，请先预览并核对未来时间，再保存。
          </p>
        </section>
        <div class="task-dialog-actions">
          <p>修改作用于未来安排，已发送记录不变。</p>
          <div>
            <button
              type="button"
              class="button secondary"
              :disabled="mutating"
              @click="editing = null"
            >
              取消</button
            ><button
              class="button primary"
              :disabled="
                mutating ||
                !session.sensitiveActive ||
                previewKey !== scheduleKey()
              "
            >
              <Save :size="16" />{{ mutating ? "正在保存…" : "保存修改" }}
            </button>
          </div>
        </div>
      </form>
    </AdminDetailDialog>
    <AdminDetailDialog
      v-if="detail"
      title="定时任务详情"
      @close="detail = null"
    >
      <div class="task-dialog-content">
        <div class="task-context">
          <span v-if="detailTask">{{ detailTask.workflowName }}</span
          ><span v-if="detailTask">{{
            detailTask.chatName ?? detailTask.chatId
          }}</span
          ><span class="task-status" :data-status="detail.task.status">{{
            labels[detail.task.status] ?? detail.task.status
          }}</span>
        </div>
        <section class="task-card task-overview">
          <p class="task-section-label"><MessageSquare :size="17" />提醒内容</p>
          <p v-if="detail.task.summary" class="task-summary-excerpt">
            {{ detail.task.summary }}
          </p>
          <p class="task-reminder">{{ detail.task.content ?? "内容已清理" }}</p>
          <div class="task-facts">
            <div>
              <span>计划时间</span
              ><strong>{{
                new Date(detail.task.scheduled_at).toLocaleString("zh-CN", {
                  timeZone: detail.task.timezone,
                })
              }}</strong
              ><small>{{ detail.task.timezone }}</small>
            </div>
            <div>
              <span>创建成员</span
              ><strong>{{ detail.task.creator_sender_id }}</strong>
            </div>
          </div>
        </section>
        <section class="task-card">
          <h3 class="task-section-label">
            <MessageSquare :size="17" />原始委托
          </h3>
          <blockquote class="task-quote">
            {{ detail.task.request_snapshot ?? "内容已清理" }}
          </blockquote>
        </section>
        <section v-if="detail.occurrences" class="task-card">
          <h3 class="task-section-label">
            <CalendarClock :size="17" />调度规则与逐次记录
          </h3>
          <p>{{ detail.summary?.scheduleSummary }}</p>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>序号</th>
                  <th>计划时间</th>
                  <th>结果</th>
                  <th>执行</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="o in detail.occurrences" :key="o.id">
                  <td>{{ o.occurrence_number }}</td>
                  <td>
                    {{
                      new Date(o.scheduled_at).toLocaleString("zh-CN", {
                        timeZone: detail.task.timezone,
                      })
                    }}
                  </td>
                  <td>
                    {{ labels[o.status] ?? o.status
                    }}<small v-if="o.reason_code"> · {{ o.reason_code }}</small>
                  </td>
                  <td>
                    <a
                      v-if="o.execution_id"
                      :href="`#/executions?executionId=${encodeURIComponent(o.execution_id)}`"
                      @click="detail = null"
                      >详情</a
                    ><span v-else>—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <footer>
            <button
              class="button secondary"
              :disabled="mutating || detailOffset === 0"
              @click="
                detailTask &&
                inspect(detailTask, Math.max(0, detailOffset - 20))
              "
            >
              上一页</button
            ><button
              class="button secondary"
              :disabled="mutating || !detail.hasMore"
              @click="detailTask && inspect(detailTask, detailOffset + 20)"
            >
              下一页
            </button>
          </footer>
        </section>
        <section class="task-card">
          <h3 class="task-section-label">
            <Play :size="17" />执行记录
            <span class="task-count">{{ detail.runs.length }}</span>
          </h3>
          <div v-if="!detail.runs.length" class="task-empty">
            <CalendarClock :size="24" />
            <div>
              <strong>还没有执行记录</strong>
              <p>任务到期受理后，会在这里显示生成方式和发送结果。</p>
            </div>
          </div>
          <article v-for="run in detail.runs" :key="run.id" class="task-run">
            <div class="task-run-heading">
              <strong>{{
                run.generation_mode === "fallback"
                  ? "固定文字兜底"
                  : run.generation_mode === "model"
                    ? "角色模型生成"
                    : "等待生成"
              }}</strong
              ><span
                class="task-status"
                :data-status="run.outcome ?? 'running'"
                >{{ labels[run.outcome ?? "running"] ?? run.outcome }}</span
              >
            </div>
            <time>{{
              new Date(run.accepted_at).toLocaleString("zh-CN", {
                timeZone: detail.task.timezone,
              })
            }}</time>
            <p v-if="run.reason_code" class="task-help">
              {{ run.reason_code }}
            </p>
            <a
              class="task-execution-link"
              :href="`#/executions?executionId=${encodeURIComponent(run.execution_id)}`"
              @click="detail = null"
              >查看执行详情 →</a
            >
          </article>
        </section>
        <section class="task-card">
          <h3 class="task-section-label">
            <History :size="17" />变更记录
            <span class="task-count">{{ detail.events.length }}</span>
          </h3>
          <p v-if="!detail.events.length" class="task-help">暂无变更记录。</p>
          <ol class="task-timeline">
            <li v-for="event in detail.events" :key="event.id">
              <div>
                <strong>{{ eventLabel(event.event_type) }}</strong
                ><time>{{
                  new Date(event.created_at).toLocaleString("zh-CN", {
                    timeZone: detail.task.timezone,
                  })
                }}</time>
              </div>
              <p v-if="event.reason_code" class="task-help">
                {{ event.reason_code }}
              </p>
            </li>
          </ol>
        </section>
        <div class="task-dialog-actions">
          <p>所有时间按 {{ detail.task.timezone }} 显示。</p>
          <button class="button secondary" @click="detail = null">
            关闭详情
          </button>
        </div>
      </div>
    </AdminDetailDialog>
    <button
      v-if="settings"
      class="button secondary"
      type="button"
      @click="openSettings"
    >
      调度与容量设置
    </button>
    <AdminFormDialog
      v-if="settings && settingsDialog"
      title="调度与容量设置"
      :busy="mutating"
      :saved-version="settings.version"
      :draft="settings"
      @close="closeSettings"
    >
      <p v-if="error" role="alert">{{ error }}</p>
      <form class="task-editor" @submit.prevent="saveSettings">
        <label
          ><input v-model="settings.paused" type="checkbox" />暂停调度</label
        ><label
          >实例待执行总数<input
            v-model.number="settings.pending_limit"
            type="number"
            min="1"
            max="10000" /></label
        ><label
          >补发窗口（分钟）<input
            v-model.number="settings.catchup_minutes"
            type="number"
            min="0"
            max="1440"
        /></label>
        <p>
          修改补发窗口影响新建、改期及后续周期实例。0
          表示只允许当前分钟内发送。恢复数据库后需先核对历史发送，再解除暂停。
        </p>
        <button
          class="button primary"
          :disabled="mutating || !session.sensitiveActive"
        >
          保存设置
        </button>
      </form>
    </AdminFormDialog>
  </section>
</template>
<style scoped>
.scheduled-tasks {
  display: grid;
  gap: 20px;
}
.scheduled-tasks header,
.task-filters,
footer {
  display: flex;
  gap: 12px;
  justify-content: space-between;
  flex-wrap: wrap;
}
.scheduled-tasks-heading {
  align-items: flex-start;
}
.scheduled-tasks-refresh {
  flex: 0 0 auto;
  align-self: flex-start;
  white-space: nowrap;
}
.task-filters label,
.task-editor label {
  display: grid;
  gap: 8px;
}
.task-filters label {
  flex: 1;
  min-width: 180px;
}
.table-scroll {
  overflow: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  text-align: left;
  padding: 12px;
  border-bottom: 1px solid #e5e7eb;
}
td:first-child {
  min-width: 160px;
  max-width: 350px;
  overflow-wrap: anywhere;
}
.task-summary-excerpt {
  margin: 0;
  font-weight: 600;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
td button {
  margin: 3px;
}
footer {
  justify-content: flex-end;
}
.task-editor {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid #e5e7eb;
  border-radius: 16px;
}
.task-editor pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 400px;
  overflow: auto;
}
input,
select,
textarea {
  max-width: 100%;
}
</style>

<style scoped>
.task-dialog-content {
  display: grid;
  gap: 16px;
  color: var(--bubblepilot-text);
}
.task-context {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--bubblepilot-muted);
  font-size: 13px;
}
.task-context > span:not(.task-status) {
  padding: 5px 10px;
  border-radius: 8px;
  background: var(--bubblepilot-bg);
}
.task-card {
  padding: 22px;
  border: 1px solid var(--bubblepilot-line);
  border-radius: 20px;
  background: var(--bubblepilot-surface);
}
.task-field {
  display: grid;
  gap: 12px;
}
.task-field-title,
.task-section-label {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 14px;
}
.task-field-title {
  margin: 0;
}
.task-section-label svg,
.task-field-title svg {
  color: var(--bubblepilot-accent);
}
.task-field textarea,
.task-field input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--bubblepilot-line);
  border-radius: 12px;
  padding: 13px 14px;
  background: var(--bubblepilot-bg-soft);
  font: inherit;
  line-height: 1.6;
  color: inherit;
}
.task-field textarea {
  resize: vertical;
  min-height: 124px;
}
.task-field input:focus,
.task-field textarea:focus {
  outline: 2px solid var(--bubblepilot-accent);
  outline-offset: 2px;
}
.task-field-hint {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--bubblepilot-muted);
}
.task-field-hint > span:last-child {
  white-space: nowrap;
}
.task-timezone {
  display: flex;
  gap: 10px;
  font-size: 13px;
  margin-top: 14px;
  color: var(--bubblepilot-muted);
}
.task-timezone strong {
  color: var(--bubblepilot-text);
  font-weight: 500;
}
.task-help {
  font-size: 13px;
  line-height: 1.7;
  color: var(--bubblepilot-muted);
  margin: 10px 0 0;
  overflow-wrap: anywhere;
}
.task-dialog-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 6px 0;
}
.task-dialog-actions p {
  font-size: 12px;
  color: var(--bubblepilot-muted);
  margin: 0;
}
.task-dialog-actions > div {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
.task-reminder {
  font-size: 20px;
  font-weight: 600;
  line-height: 1.6;
  margin: 0 0 22px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.task-facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  border-top: 1px solid var(--bubblepilot-line);
  padding-top: 18px;
}
.task-facts > div {
  display: grid;
  gap: 7px;
  align-content: start;
  min-width: 0;
}
.task-facts span,
.task-facts small {
  font-size: 12px;
  color: var(--bubblepilot-muted);
}
.task-facts strong {
  font-size: 14px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.task-quote {
  margin: 0;
  border-left: 3px solid var(--bubblepilot-accent);
  padding: 12px 16px;
  background: var(--bubblepilot-bg-soft);
  border-radius: 0 10px 10px 0;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.task-status {
  display: inline-flex;
  padding: 5px 10px;
  border-radius: 999px;
  background: var(--bubblepilot-bg);
  color: var(--bubblepilot-muted);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.task-status[data-status="pending"],
.task-status[data-status="running"] {
  background: #eaf4ff;
  color: #0875dc;
}
.task-status[data-status="sent"] {
  background: #e8f6f0;
  color: #11865f;
}
.task-status[data-status="failed"],
.task-status[data-status="delivery_unknown"] {
  background: #fff0ed;
  color: #bf453b;
}
.task-count {
  margin-left: auto;
  border-radius: 6px;
  padding: 2px 7px;
  background: var(--bubblepilot-bg);
  font-size: 12px;
  color: var(--bubblepilot-muted);
}
.task-empty {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 20px 16px;
  background: var(--bubblepilot-bg-soft);
  border-radius: 12px;
  color: var(--bubblepilot-muted);
}
.task-empty strong {
  font-size: 14px;
  font-weight: 500;
  color: var(--bubblepilot-text);
}
.task-empty p {
  font-size: 13px;
  line-height: 1.6;
  margin: 6px 0 0;
}
.task-empty svg {
  flex-shrink: 0;
}
.task-run {
  padding: 14px 0;
  border-top: 1px solid var(--bubblepilot-line);
}
.task-run-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 14px;
}
.task-run time,
.task-timeline time {
  font-size: 12px;
  color: var(--bubblepilot-muted);
}
.task-run > time {
  display: block;
  margin-top: 8px;
}
.task-execution-link {
  display: inline-block;
  color: var(--bubblepilot-accent);
  font-size: 13px;
  margin-top: 12px;
  text-decoration: none;
}
.task-timeline {
  list-style: none;
  margin: 0;
  padding: 0 0 0 6px;
}
.task-timeline li {
  position: relative;
  padding: 0 0 22px 22px;
  border-left: 1px solid var(--bubblepilot-line);
}
.task-timeline li:last-child {
  padding-bottom: 0;
}
.task-timeline li::before {
  content: "";
  position: absolute;
  left: -4px;
  top: 6px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--bubblepilot-accent);
}
.task-timeline li > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.task-timeline strong {
  font-size: 14px;
  font-weight: 500;
}
.task-alert {
  padding: 12px 16px;
  border-radius: 12px;
  background: #fff0ed;
  color: var(--bubblepilot-danger);
  font-size: 13px;
  margin: 0;
}
@media (max-width: 600px) {
  .task-card {
    padding: 16px;
    border-radius: 16px;
  }
  .task-facts {
    grid-template-columns: 1fr;
  }
  .task-dialog-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .task-dialog-actions > div {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .task-field-hint {
    flex-wrap: wrap;
  }
  .task-reminder {
    font-size: 18px;
  }
  .task-empty {
    align-items: flex-start;
  }
}
</style>
