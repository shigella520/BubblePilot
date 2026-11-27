<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { Archive, Pencil, RefreshCw, Save } from "@lucide/vue";
import AdminFormDialog from "./AdminFormDialog.vue";
import DismissibleMessage from "./DismissibleMessage.vue";
import { apiRequest, errorMessage, jsonBody } from "../services/api";
import { useSessionStore } from "../stores/session";
import { formatDateTime } from "../utils/format";

/** Retention of execution details (doc/迭代需求-性能优化.md P3). */
interface Settings {
  executionDetailDays: number;
  version: number;
  updatedAt: string | null;
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
    const value = await apiRequest<Settings>("/api/v1/system/data-retention");
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
    const saved = await apiRequest<Settings>("/api/v1/system/data-retention", {
      method: "PUT",
      body: jsonBody({
        executionDetailDays: value.executionDetailDays,
        expectedVersion: value.version,
      }),
    });
    if (ticket !== generation) return;
    current.value = saved;
    draft.value = null;
    failed.value = false;
    message.value =
      "数据保留设置已保存，从下一次数据整理（约 10 分钟内）开始生效。";
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
  <section id="data-retention" class="admin-panel data-retention-settings">
    <div class="panel-head">
      <div>
        <p class="card-kicker">数据保留</p>
        <h2>执行明细保留</h2>
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
      执行结束超过保留期限后，自动删除其节点轨迹、AI
      工具调用、路由决策和图片输入明细；执行记录本身、出站发送和用量统计保留。
    </p>
    <DismissibleMessage
      v-if="message && !draft"
      :error="failed"
      @close="message = ''"
      >{{ message }}</DismissibleMessage
    >
    <dl v-if="current" class="settings-summary">
      <div>
        <dt>执行明细保留</dt>
        <dd>{{ current.executionDetailDays }} 天</dd>
      </div>
      <div>
        <dt>最后修改</dt>
        <dd>{{ formatDateTime(current.updatedAt, "使用默认值") }}</dd>
      </div>
    </dl>
    <AdminFormDialog
      v-if="draft"
      :sensitive-required="true"
      title="数据保留设置"
      :busy="saving"
      :saved-version="current?.version"
      :draft="draft"
      @close="draft = null"
    >
      <DismissibleMessage
        v-if="message"
        :error="failed"
        @close="message = ''"
        >{{ message }}</DismissibleMessage
      >
      <form class="settings-form" @submit.prevent="save">
        <div class="field-grid">
          <label class="wide-field"
            ><span>执行明细保留天数</span
            ><input
              v-model.number="draft.executionDetailDays"
              type="number"
              min="7"
              max="3650"
              step="1"
              required
            /><small
              >默认 90 天，可设为 7～3650
              天，按执行结束时间计算；未结束的执行不受影响。</small
            ></label
          >
        </div>
        <p
          v-if="
            current && draft.executionDetailDays < current.executionDetailDays
          "
          class="retention-warning"
          role="status"
        >
          缩短保留期限后，超过新期限的执行明细会在后续清理中删除，无法在页面撤销；延长保留期限也无法恢复已清理内容。
        </p>
        <div class="form-actions">
          <span class="panel-description"
            ><Archive :size="16" />保存需要敏感操作授权</span
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
