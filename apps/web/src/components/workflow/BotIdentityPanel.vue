<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from "vue";
import BotHistoryRebuildPanel from "../BotHistoryRebuildPanel.vue";
import { Bot, RefreshCw } from "@lucide/vue";
import AdminDetailDialog from "../AdminDetailDialog.vue";
import { apiRequest, errorMessage } from "../../services/api";
const props = defineProps<{ workflowId: string }>();

interface Identity {
  nickname: string | null;
  version: number;
  updatedAt: string | null;
}
interface Status {
  workflows: Array<{
    workflowId: string;
    name: string;
    nickname: string | null;
    total: number;
    bound: number;
    unbound: number;
    nicknamePending: number;
  }>;
  jobs: Array<{
    id: string;
    status: string;
    processed: number;
    error_code: string | null;
  }>;
}
const open = ref(false),
  loading = ref(false),
  busy = ref(false),
  nickname = ref(""),
  notice = ref("");
const identity = ref<Identity | null>(null),
  status = ref<Status | null>(null);
const workflows = computed(() =>
  (status.value?.workflows ?? []).filter(
    (w) => w.workflowId === props.workflowId,
  ),
);
let generation = 0;
onBeforeUnmount(() => generation++);
function close() {
  open.value = false;
  generation++;
}
async function show() {
  open.value = true;
  identity.value = null;
  status.value = null;
  notice.value = "";
  await refresh(true);
}
async function refresh(includeIdentity = false) {
  if (loading.value) return;
  const token = ++generation;
  loading.value = true;
  try {
    const [s, i] = await Promise.all([
      apiRequest<Status>(
        `/api/v1/bot-attributions?workflowId=${props.workflowId}`,
      ),
      includeIdentity
        ? apiRequest<Identity>(
            `/api/v1/workflows/${props.workflowId}/bot-identity`,
          )
        : Promise.resolve(null),
    ]);
    if (token !== generation) return;
    status.value = s;
    if (i) {
      identity.value = i;
      nickname.value = i.nickname ?? "";
    }
  } catch (e) {
    if (token === generation) notice.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
async function act(saveNickname: boolean) {
  if (busy.value || loading.value) return;
  busy.value = true;
  const token = generation;
  try {
    const result = await apiRequest<Identity>(
      saveNickname
        ? `/api/v1/workflows/${props.workflowId}/bot-identity`
        : "/api/v1/bot-attributions/backfill",
      {
        method: saveNickname ? "PUT" : "POST",
        ...(saveNickname
          ? {
              body: JSON.stringify({
                nickname: nickname.value,
                expectedVersion: identity.value?.version,
              }),
            }
          : { body: JSON.stringify({ workflowId: props.workflowId }) }),
      },
    );
    if (token !== generation) return;
    if (saveNickname) {
      identity.value = result;
      nickname.value = result.nickname ?? "";
    }
    notice.value = saveNickname
      ? "角色昵称已保存。首次昵称的历史补充由后台任务完成。"
      : "历史归属回填已启动，请刷新查看进度。";
    await refresh();
  } catch (e) {
    if (token === generation) notice.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function retry(id: string) {
  if (busy.value || loading.value) return;
  busy.value = true;
  const token = generation;
  try {
    await apiRequest(`/api/v1/bot-attributions/${id}/retry`, {
      method: "POST",
    });
    if (token === generation) await refresh();
  } catch (e) {
    if (token === generation) notice.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
const stateLabel = (s: string) =>
  ({
    queued: "等待中",
    running: "处理中",
    succeeded: "已完成",
    failed: "失败",
  })[s] ?? s;
</script>
<template>
  <button
    class="button secondary"
    type="button"
    :disabled="loading || busy"
    @click="show"
  >
    <Bot :size="16" />角色与归属
  </button>
  <AdminDetailDialog v-if="open" title="Bot 角色与历史归属" @close="close">
    <p class="muted">
      一个自动化对应一个稳定角色。改昵称保留身份；换角色请新建自动化。
    </p>
    <p v-if="loading && !identity" role="status">正在加载角色配置…</p>
    <form v-if="identity" class="identity-form" @submit.prevent="act(true)">
      <label
        >角色昵称<input
          v-model="nickname"
          maxlength="120"
          required
          :disabled="busy"
      /></label>
      <button
        class="button primary"
        :disabled="busy || loading || !nickname.trim()"
      >
        保存角色昵称
      </button>
      <small
        >版本 {{ identity.version }} ·
        {{
          identity.updatedAt
            ? new Date(identity.updatedAt).toLocaleString()
            : "尚未配置"
        }}</small
      >
    </form>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div class="panel-head">
      <h3>本自动化的历史消息</h3>
      <button
        class="button secondary"
        :disabled="busy || loading"
        @click="refresh()"
      >
        <RefreshCw :size="16" />{{ loading ? "刷新中…" : "刷新归属状态" }}
      </button>
    </div>
    <template v-if="status">
      <div class="coverage-table">
        <table>
          <thead>
            <tr>
              <th>自动化 / 角色</th>
              <th>可归属</th>
              <th>已绑定</th>
              <th>待绑定</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in workflows"
              :key="item.workflowId"
              :class="{ current: item.workflowId === workflowId }"
            >
              <td>
                {{ item.name
                }}<small
                  >{{ item.nickname ?? "未配置昵称"
                  }}{{
                    item.workflowId === workflowId ? " · 当前自动化" : ""
                  }}</small
                ><small v-if="item.nicknamePending"
                  >{{ item.nicknamePending }} 条已绑定消息待补昵称</small
                >
              </td>
              <td>{{ item.total }}</td>
              <td>{{ item.bound }}</td>
              <td>{{ item.unbound }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="muted">
        按归档消息条数统计，仅包含能够精确匹配到本自动化的消息；来源未知及归属冲突不计入。
      </p>
      <button
        class="button secondary"
        :disabled="busy || loading"
        @click="act(false)"
      >
        回填本自动化历史归属
      </button>
      <p class="muted">
        回填不调用模型。首次昵称会补充到已匹配历史，之后改名不改写历史昵称。
      </p>
      <details v-if="status.jobs.length" class="jobs">
        <summary>近期归属任务</summary>
        <p v-for="job in status.jobs" :key="job.id">
          {{ stateLabel(job.status) }} · 已扫描 {{ job.processed }} 条
          <span v-if="job.error_code">{{ job.error_code }}</span
          ><button
            v-if="job.status === 'failed'"
            class="button secondary"
            :disabled="busy || loading"
            @click="retry(job.id)"
          >
            重试
          </button>
        </p>
      </details>
    </template>
    <p class="muted">
      以下仅列出本自动化有发送记录的聊天。重建会更新聊天共享的摘要或索引，并产生模型用量；请先完成昵称配置及历史归属回填。
    </p>
    <BotHistoryRebuildPanel :workflow-id="workflowId" target="summary" />
    <BotHistoryRebuildPanel :workflow-id="workflowId" target="memory" />
  </AdminDetailDialog>
</template>
<style scoped>
.muted,
small {
  color: #667085;
  font-size: 13px;
  line-height: 1.6;
}
.identity-form {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: end;
  margin: 20px 0;
}
.identity-form label {
  flex: 1 1 240px;
}
.identity-form small {
  width: 100%;
}
.panel-head {
  margin-top: 24px;
  gap: 12px;
  flex-wrap: wrap;
}
.coverage-table {
  overflow: auto;
  max-height: 340px;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  padding: 12px;
  text-align: left;
  border-bottom: 1px solid #e0e4e8;
}
td small {
  display: block;
}
.current {
  background: #edf5ff;
}
.jobs {
  margin-top: 16px;
}
</style>
