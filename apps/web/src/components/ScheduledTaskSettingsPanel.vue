<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { CalendarClock, Pencil, RefreshCw, Save } from "@lucide/vue";
import AdminFormDialog from "./AdminFormDialog.vue";
import DismissibleMessage from "./DismissibleMessage.vue";
import ToggleSwitch from "./ToggleSwitch.vue";
import { apiRequest, errorMessage, jsonBody } from "../services/api";
import { useSessionStore } from "../stores/session";
interface Settings {
  paused: boolean;
  pending_limit: number;
  catchup_minutes: number;
  retention_days: number;
  version: number;
}
const session = useSessionStore();
const current = ref<Settings | null>(null);
const draft = ref<Settings | null>(null);
const busy = ref(false);
const saving = ref(false);
const message = ref("");
const failed = ref(false);
let generation = 0;
async function load() {
  if (busy.value || saving.value || draft.value) return;
  const ticket = ++generation;
  busy.value = true;
  message.value = "";
  try {
    const value = await apiRequest<Settings>(
      "/api/v1/settings/scheduled-tasks",
    );
    if (ticket === generation) current.value = value;
  } catch (cause) {
    if (ticket === generation) {
      failed.value = true;
      message.value = errorMessage(cause);
    }
  } finally {
    if (ticket === generation) busy.value = false;
  }
}
function edit() {
  if (!current.value || busy.value || saving.value) return;
  draft.value = { ...current.value };
  message.value = "";
}
async function save() {
  if (!draft.value || saving.value || !session.sensitiveActive) return;
  const ticket = ++generation;
  saving.value = true;
  message.value = "";
  const value = draft.value;
  try {
    const saved = await apiRequest<Settings>(
      "/api/v1/settings/scheduled-tasks",
      {
        method: "PUT",
        body: jsonBody({
          paused: value.paused,
          pendingLimit: value.pending_limit,
          catchupMinutes: value.catchup_minutes,
          retentionDays: value.retention_days,
          expectedVersion: value.version,
        }),
      },
    );
    if (ticket !== generation) return;
    current.value = saved;
    draft.value = null;
    failed.value = false;
    message.value = "定时任务设置已保存，新的保留期限从下一次清理检查生效。";
  } catch (cause) {
    if (ticket === generation) {
      failed.value = true;
      message.value = errorMessage(cause);
    }
  } finally {
    if (ticket === generation) saving.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => generation++);
</script>
<template>
  <section
    id="scheduled-task-settings"
    class="admin-panel scheduled-task-settings"
  >
    <div class="panel-head">
      <div>
        <p class="card-kicker">SCHEDULED TASKS</p>
        <h2>定时任务</h2>
      </div>
      <div class="settings-actions">
        <button
          class="button secondary"
          :disabled="busy || saving || !!draft"
          @click="load"
        >
          <RefreshCw :size="16" />{{ busy ? "刷新中…" : "刷新" }}
        </button>
        <button
          class="button primary"
          :disabled="!current || busy || saving"
          @click="edit"
        >
          <Pencil :size="16" />修改设置
        </button>
      </div>
    </div>
    <p class="panel-description">
      统一管理提醒调度、实例容量和历史任务保留期限。任务列表和执行详情仍在“执行与审计”中查看。
    </p>
    <DismissibleMessage
      v-if="message && !draft"
      :error="failed"
      inline
      @close="message = ''"
      >{{ message }}</DismissibleMessage
    >
    <dl v-if="current" class="settings-summary">
      <div>
        <dt>调度状态</dt>
        <dd>{{ current.paused ? "已暂停" : "正常调度" }}</dd>
      </div>
      <div>
        <dt>实例活动任务上限</dt>
        <dd>{{ current.pending_limit }} 项</dd>
      </div>
      <div>
        <dt>补发窗口</dt>
        <dd>{{ current.catchup_minutes }} 分钟</dd>
      </div>
      <div>
        <dt>历史任务保留</dt>
        <dd>{{ current.retention_days }} 天</dd>
      </div>
    </dl>
    <p class="panel-description">
      活动和暂停的任务不会整项自动删除；暂停调度不暂停已结束任务清理。
    </p>
    <AdminFormDialog
      v-if="draft"
      title="定时任务设置"
      :busy="saving"
      :saved-version="current?.version"
      :draft="draft"
      @close="draft = null"
    >
      <DismissibleMessage
        v-if="message"
        :error="failed"
        inline
        @close="message = ''"
        >{{ message }}</DismissibleMessage
      >
      <form class="settings-form" @submit.prevent="save">
        <div class="schedule-toggle">
          <div>
            <strong>暂停调度</strong>
            <p class="panel-description">
              停止受理新的到期任务；恢复时跳过暂停期间的周期。
            </p>
          </div>
          <ToggleSwitch
            v-model="draft.paused"
            label="暂停调度"
            :disabled="saving || !session.sensitiveActive"
          />
        </div>
        <div class="field-grid">
          <label
            ><span>实例活动任务上限</span
            ><input
              v-model.number="draft.pending_limit"
              type="number"
              min="1"
              max="10000"
              step="1"
              required
            /><small>包含待执行、执行中和暂停的任务。</small></label
          >
          <label
            ><span>补发窗口（分钟）</span
            ><input
              v-model.number="draft.catchup_minutes"
              type="number"
              min="0"
              max="1440"
              step="1"
              required
            /><small>0 表示只允许计划时刻起一分钟内发送。</small></label
          >
          <label class="wide-field"
            ><span>历史任务保留天数</span
            ><input
              v-model.number="draft.retention_days"
              type="number"
              min="7"
              max="180"
              step="1"
              required
            /><small
              >默认 30 天，可设为 7～180
              天。已结束任务按结束时间清理；历史周期实例及运行正文按各自保留时间清理。</small
            ></label
          >
        </div>
        <p class="panel-description">
          修改补发窗口影响新建、改期及后续周期实例。恢复数据库后需先核对历史发送，再解除暂停。
        </p>
        <p
          v-if="current && draft.retention_days < current.retention_days"
          class="retention-warning"
          role="status"
        >
          缩短保留期限后，超过新期限的任务和历史正文会在后续清理中删除，无法在页面撤销；延长保留期限也无法恢复已清理内容。
        </p>
        <div class="form-actions">
          <span class="panel-description"
            ><CalendarClock :size="16" />保存需要敏感操作授权</span
          ><button
            class="button primary"
            :disabled="saving || !session.sensitiveActive"
            :aria-busy="saving"
          >
            <Save :size="16" />{{ saving ? "保存中…" : "保存设置" }}
          </button>
        </div>
      </form>
    </AdminFormDialog>
  </section>
</template>
<style scoped>
.settings-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.settings-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
  gap: 16px;
  margin: 20px 0;
}
.settings-summary div {
  min-width: 0;
  padding: 16px;
  border-radius: 16px;
  background: var(--bubblepilot-surface, rgba(255, 255, 255, 0.65));
}
dt {
  color: var(--bubblepilot-muted);
  font-size: 13px;
}
dd {
  margin: 8px 0 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.schedule-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.schedule-toggle > div {
  min-width: 0;
}
.retention-warning {
  padding: 12px 16px;
  border-radius: 12px;
  background: #fff5e6;
  color: #724211;
}
@media (max-width: 680px) {
  .settings-actions {
    width: 100%;
  }
  .settings-actions .button {
    flex: 1 1 auto;
  }
}
</style>
