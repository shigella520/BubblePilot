<script setup lang="ts">
import {
  Boxes,
  GitBranch,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  ToggleLeft,
} from "@lucide/vue";
import { computed, onMounted, reactive, ref, watch } from "vue";

import SensitiveUnlock from "../components/SensitiveUnlock.vue";
import {
  apiRequest,
  errorMessage,
  jsonBody,
  parseJsonObject,
} from "../services/api";
import { useSessionStore } from "../stores/session";

interface Workflow {
  id: string;
  name: string;
  status: string;
  publishedVersion: number | null;
  updatedAt: string;
}
interface WorkflowVersion {
  id: string;
  workflowId: string;
  workflowName: string;
  version: number;
  status: string;
  definition: unknown;
}
interface Trigger {
  id: string;
  name: string;
  workflowId: string;
  workflowVersion: number;
  conditions: unknown;
  enabled: boolean;
  conflictingTriggerIds: string[];
}
interface TriggerPreviewResult {
  matched: boolean;
  checks: Array<{
    field:
      "chat" | "sender" | "contentType" | "text" | "timeWindow" | "isFromMe";
    matched: boolean;
  }>;
}

const session = useSessionStore();
function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}
const workflows = ref<Workflow[]>([]);
const versions = ref<WorkflowVersion[]>([]);
const triggers = ref<Trigger[]>([]);
const selectedWorkflowId = ref("");
const busy = ref(false);
const message = ref("");
const messageIsError = ref(false);
const workflowCreateBusy = ref(false);
const versionCreateBusy = ref(false);
const publishBusy = ref(false);
const triggerCreateBusy = ref(false);
const workflowToggleBusyIds = reactive(new Set<string>());
const triggerToggleBusyIds = reactive(new Set<string>());
let versionsRequestId = 0;
const createForm = reactive({ name: "", definition: "" });
const versionDefinition = ref("");
const triggerForm = reactive({
  name: "",
  workflowId: "",
  conditions: '{\n  "chatIds": [],\n  "text": null,\n  "timeWindow": null\n}',
});
const localDateTimeValue = (date: Date) => {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
};
const triggerPreviewForm = reactive({
  providerChatId: "iMessage;-;fictional-preview-chat",
  senderId: "fictional-user@example.test",
  sentAt: localDateTimeValue(new Date()),
  contentType: "text",
  text: "fictional preview message",
  isFromMe: false,
});
const triggerPreview = ref<TriggerPreviewResult | null>(null);

const defaultDefinition = (name: string) =>
  JSON.stringify(
    {
      schemaVersion: "1",
      name: name || "New workflow",
      startNodeId: "end",
      maxSteps: 64,
      maxExecutionMs: 60000,
      nodes: [
        { id: "end", type: "end", version: 1, config: { result: "succeeded" } },
      ],
    },
    null,
    2,
  );
const latestCandidate = computed(
  () =>
    versions.value.find((item) => item.status === "validated") ??
    versions.value[0] ??
    null,
);
const activeWorkflows = computed(() =>
  workflows.value.filter(
    (item) => item.publishedVersion !== null && item.status === "active",
  ),
);
const triggerNames = computed(
  () => new Map(triggers.value.map((trigger) => [trigger.id, trigger.name])),
);

function conflictingTriggerNames(trigger: Trigger): string {
  return trigger.conflictingTriggerIds
    .map((id) => triggerNames.value.get(id) ?? id.slice(0, 8))
    .join("、");
}

async function load() {
  busy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    [workflows.value, triggers.value] = await Promise.all([
      apiRequest<Workflow[]>("/api/v1/workflows"),
      apiRequest<Trigger[]>("/api/v1/triggers"),
    ]);
    if (!selectedWorkflowId.value && workflows.value[0])
      selectedWorkflowId.value = workflows.value[0].id;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    busy.value = false;
  }
}

async function loadVersions() {
  const requestId = ++versionsRequestId;
  const workflowId = selectedWorkflowId.value;
  if (!workflowId) {
    versions.value = [];
    versionDefinition.value = "";
    return;
  }
  try {
    versions.value = await apiRequest<WorkflowVersion[]>(
      `/api/v1/workflows/${workflowId}/versions`,
    );
    if (
      requestId !== versionsRequestId ||
      workflowId !== selectedWorkflowId.value
    )
      return;
    versionDefinition.value = JSON.stringify(
      versions.value[0]?.definition ?? {},
      null,
      2,
    );
  } catch (cause) {
    if (requestId !== versionsRequestId) return;
    message.value = errorMessage(cause);
    messageIsError.value = true;
  }
}

async function createWorkflow() {
  if (workflowCreateBusy.value) return;
  workflowCreateBusy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    const definition = parseJsonObject(
      createForm.definition || defaultDefinition(createForm.name),
    );
    const created = await apiRequest<WorkflowVersion>("/api/v1/workflows", {
      method: "POST",
      body: jsonBody({ name: createForm.name, definition }),
    });
    createForm.name = "";
    createForm.definition = "";
    await load();
    selectedWorkflowId.value = created.workflowId;
    message.value = `已创建工作流「${created.workflowName}」及候选版本 v${created.version}。`;
    messageIsError.value = false;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    workflowCreateBusy.value = false;
  }
}

async function createVersion() {
  if (!selectedWorkflowId.value || versionCreateBusy.value) return;
  versionCreateBusy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    const created = await apiRequest<WorkflowVersion>(
      `/api/v1/workflows/${selectedWorkflowId.value}/versions`,
      {
        method: "POST",
        body: jsonBody({
          definition: parseJsonObject(versionDefinition.value),
        }),
      },
    );
    versions.value = [created, ...versions.value];
    versionDefinition.value = JSON.stringify(created.definition, null, 2);
    message.value = `已创建工作流「${created.workflowName}」候选版本 v${created.version}。`;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    versionCreateBusy.value = false;
  }
}

async function publish() {
  if (!latestCandidate.value || !session.sensitiveActive || publishBusy.value)
    return;
  const candidate = latestCandidate.value;
  publishBusy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    const published = await apiRequest<WorkflowVersion>(
      `/api/v1/workflows/${candidate.workflowId}/versions/${candidate.version}/publish`,
      { method: "POST" },
    );
    versions.value = versions.value.map((item) =>
      item.id === published.id ? published : item,
    );
    workflows.value = workflows.value.map((item) =>
      item.id === published.workflowId
        ? {
            ...item,
            status: "active",
            publishedVersion: published.version,
            updatedAt: new Date().toISOString(),
          }
        : item,
    );
    message.value = `已发布工作流「${published.workflowName}」v${published.version}。`;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    publishBusy.value = false;
  }
}

async function toggleWorkflow(workflow: Workflow) {
  if (
    !session.sensitiveActive ||
    workflow.publishedVersion === null ||
    workflowToggleBusyIds.has(workflow.id)
  )
    return;
  workflowToggleBusyIds.add(workflow.id);
  message.value = "";
  messageIsError.value = false;
  try {
    const updated = await apiRequest<Workflow>(
      `/api/v1/workflows/${workflow.id}/enabled`,
      {
        method: "PATCH",
        body: jsonBody({ enabled: workflow.status !== "active" }),
      },
    );
    workflows.value = workflows.value.map((item) =>
      item.id === updated.id ? updated : item,
    );
    message.value = `工作流「${updated.name}」已${updated.status === "active" ? "开始接收新执行" : "停止接收新执行"}。`;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    workflowToggleBusyIds.delete(workflow.id);
  }
}

async function previewTrigger() {
  try {
    triggerPreview.value = await apiRequest<TriggerPreviewResult>(
      "/api/v1/triggers/preview",
      {
        method: "POST",
        body: jsonBody({
          conditions: parseJsonObject(triggerForm.conditions),
          includeFromMe: false,
          sample: {
            providerChatId: triggerPreviewForm.providerChatId,
            senderId: triggerPreviewForm.senderId || null,
            sentAt: new Date(triggerPreviewForm.sentAt).toISOString(),
            contentType: triggerPreviewForm.contentType,
            text: triggerPreviewForm.text || null,
            isFromMe: triggerPreviewForm.isFromMe,
          },
        }),
      },
    );
  } catch (cause) {
    message.value = errorMessage(cause);
  }
}

async function createTrigger() {
  if (!session.sensitiveActive || triggerCreateBusy.value) return;
  const workflow = workflows.value.find(
    (item) => item.id === triggerForm.workflowId,
  );
  if (!workflow?.publishedVersion) return;
  triggerCreateBusy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    const created = await apiRequest<Trigger>("/api/v1/triggers", {
      method: "POST",
      body: jsonBody({
        name: triggerForm.name,
        workflowId: workflow.id,
        workflowVersion: workflow.publishedVersion,
        conditions: parseJsonObject(triggerForm.conditions),
        includeFromMe: false,
        enabled: false,
      }),
    });
    triggers.value = [
      {
        ...created,
        conflictingTriggerIds: created.conflictingTriggerIds ?? [],
      },
      ...triggers.value,
    ];
    triggerForm.name = "";
    message.value = `已创建停用触发器「${created.name}」。`;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    triggerCreateBusy.value = false;
  }
}

async function toggleTrigger(trigger: Trigger) {
  if (!session.sensitiveActive || triggerToggleBusyIds.has(trigger.id)) return;
  triggerToggleBusyIds.add(trigger.id);
  message.value = "";
  messageIsError.value = false;
  try {
    const updated = await apiRequest<Trigger>(
      `/api/v1/triggers/${trigger.id}`,
      { method: "PATCH", body: jsonBody({ enabled: !trigger.enabled }) },
    );
    const normalized = {
      ...updated,
      conflictingTriggerIds: trigger.conflictingTriggerIds,
    };
    triggers.value = triggers.value.map((item) =>
      item.id === normalized.id ? normalized : item,
    );
    message.value = `触发器「${normalized.name}」已${normalized.enabled ? "启用" : "停用"}。`;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    triggerToggleBusyIds.delete(trigger.id);
  }
}

watch(selectedWorkflowId, loadVersions);
watch(
  () => createForm.name,
  (name) => {
    if (!createForm.definition) createForm.definition = defaultDefinition(name);
  },
);
onMounted(load);
</script>

<template>
  <main class="page-container split-admin-page reveal">
    <aside class="admin-sidebar">
      <div>
        <p class="eyebrow">AUTOMATION</p>
        <h2>流程与触发器</h2>
      </div>
      <nav>
        <button
          class="active"
          type="button"
          @click="scrollToSection('workflows')"
        >
          <Boxes :size="18" />工作流
        </button>
        <button type="button" @click="scrollToSection('triggers')">
          <GitBranch :size="18" />触发器
        </button>
      </nav>
      <div class="sidebar-note">
        候选版本先校验，完成二次验证后才可发布到生产消息。
      </div>
    </aside>
    <div class="admin-workspace">
      <SensitiveUnlock />
      <p v-if="message" class="form-message" :class="{ error: messageIsError }">
        {{ message }}
      </p>
      <section id="workflows" class="admin-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">VERSIONED WORKFLOWS</p>
            <h1>工作流</h1>
          </div>
          <button class="button secondary" @click="load">
            <RefreshCw :size="16" />刷新
          </button>
        </div>
        <div class="two-column-forms">
          <form class="settings-form" @submit.prevent="createWorkflow">
            <h3><Plus :size="18" />新建工作流</h3>
            <label
              ><span>名称</span
              ><input
                v-model.trim="createForm.name"
                maxlength="120"
                required /></label
            ><label
              ><span>版本 1 定义（JSON）</span
              ><textarea
                v-model="createForm.definition"
                rows="12"
                required
              ></textarea></label
            ><button
              class="button primary"
              type="submit"
              :disabled="workflowCreateBusy"
              :aria-busy="workflowCreateBusy"
            >
              <Plus :size="16" />{{
                workflowCreateBusy ? "创建中…" : "创建候选版本"
              }}
            </button>
          </form>
          <form class="settings-form" @submit.prevent="createVersion">
            <h3><Save :size="18" />编辑候选版本</h3>
            <label
              ><span>工作流</span
              ><select v-model="selectedWorkflowId">
                <option value="">请选择</option>
                <option
                  v-for="workflow in workflows"
                  :key="workflow.id"
                  :value="workflow.id"
                >
                  {{ workflow.name }} · {{ workflow.status }}
                </option>
              </select></label
            ><label
              ><span>新版本定义（JSON）</span
              ><textarea
                v-model="versionDefinition"
                rows="12"
                required
              ></textarea>
            </label>
            <div class="form-actions">
              <button
                class="button secondary"
                type="submit"
                :disabled="!selectedWorkflowId || versionCreateBusy"
                :aria-busy="versionCreateBusy"
              >
                <Save :size="16" />{{
                  versionCreateBusy ? "保存中…" : "保存新版本"
                }}</button
              ><button
                class="button primary"
                type="button"
                :disabled="
                  !session.sensitiveActive || !latestCandidate || publishBusy
                "
                :aria-busy="publishBusy"
                @click="publish"
              >
                <Play :size="16" />{{
                  publishBusy
                    ? "发布中…"
                    : `发布 v${latestCandidate?.version || "-"}`
                }}
              </button>
            </div>
          </form>
        </div>
        <div class="table-shell">
          <table>
            <thead>
              <tr>
                <th>工作流</th>
                <th>状态</th>
                <th>已发布</th>
                <th>更新时间</th>
                <th>新执行</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!workflows.length">
                <td colspan="5" class="empty-cell">暂无工作流</td>
              </tr>
              <tr v-for="workflow in workflows" :key="workflow.id">
                <td>
                  <strong>{{ workflow.name }}</strong
                  ><span class="keyline">{{ workflow.id }}</span>
                </td>
                <td>
                  <span class="table-status" :class="workflow.status">{{
                    workflow.status
                  }}</span>
                </td>
                <td>
                  {{
                    workflow.publishedVersion
                      ? `v${workflow.publishedVersion}`
                      : "—"
                  }}
                </td>
                <td>{{ new Date(workflow.updatedAt).toLocaleString() }}</td>
                <td>
                  <button
                    class="switch-button"
                    :class="{ active: workflow.status === 'active' }"
                    type="button"
                    :disabled="
                      !session.sensitiveActive ||
                      workflow.publishedVersion === null ||
                      workflowToggleBusyIds.has(workflow.id)
                    "
                    :aria-busy="workflowToggleBusyIds.has(workflow.id)"
                    @click="toggleWorkflow(workflow)"
                  >
                    <span></span
                    >{{
                      workflowToggleBusyIds.has(workflow.id)
                        ? "处理中…"
                        : workflow.status === "active"
                          ? "接收中"
                          : "已停止"
                    }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section id="triggers" class="admin-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">BOT EVENTS</p>
            <h2>Bot 触发器</h2>
          </div>
          <span class="state-badge">AND 条件组合</span>
        </div>
        <form
          class="settings-form boxed-form trigger-preview-form"
          @submit.prevent="previewTrigger"
        >
          <h3><ShieldAlert :size="18" />条件预览（无副作用）</h3>
          <p class="panel-description">
            使用下方待保存条件和一条虚构样本解释每一项匹配结果，不创建执行、不调用节点。
          </p>
          <div class="field-grid">
            <label
              ><span>样本聊天 GUID</span
              ><input v-model.trim="triggerPreviewForm.providerChatId" required
            /></label>
            <label
              ><span>样本发送者</span
              ><input v-model.trim="triggerPreviewForm.senderId"
            /></label>
            <label
              ><span>样本时间</span
              ><input
                v-model="triggerPreviewForm.sentAt"
                type="datetime-local"
                required
            /></label>
            <label
              ><span>消息类型</span
              ><select v-model="triggerPreviewForm.contentType">
                <option value="text">text</option>
                <option value="attachment">attachment</option>
                <option value="mixed">mixed</option>
                <option value="unknown">unknown</option>
              </select></label
            >
            <label class="wide-field"
              ><span>样本文本</span><input v-model="triggerPreviewForm.text"
            /></label>
          </div>
          <label class="checkbox-field"
            ><input
              v-model="triggerPreviewForm.isFromMe"
              type="checkbox"
            /><span
              >样本由 Bot 自己发送（生产规则仍固定拒绝自触发）</span
            ></label
          >
          <div class="form-actions trigger-preview-actions">
            <div
              v-if="triggerPreview"
              class="trigger-preview-result"
              :class="{ matched: triggerPreview.matched }"
            >
              <strong>{{ triggerPreview.matched ? "匹配" : "不匹配" }}</strong>
              <span
                v-for="check in triggerPreview.checks"
                :key="check.field"
                :class="{ passed: check.matched }"
                >{{ check.field }} {{ check.matched ? "✓" : "×" }}</span
              >
            </div>
            <button class="button secondary" type="submit">
              <Play :size="16" />预览条件
            </button>
          </div>
        </form>
        <form class="inline-create-form" @submit.prevent="createTrigger">
          <label
            ><span>名称</span
            ><input
              v-model.trim="triggerForm.name"
              maxlength="120"
              required /></label
          ><label
            ><span>已发布工作流</span
            ><select v-model="triggerForm.workflowId" required>
              <option value="">请选择</option>
              <option
                v-for="workflow in activeWorkflows"
                :key="workflow.id"
                :value="workflow.id"
              >
                {{ workflow.name }} · v{{ workflow.publishedVersion }}
              </option>
            </select></label
          ><label class="wide-field"
            ><span>条件（JSON）</span
            ><textarea
              v-model="triggerForm.conditions"
              rows="5"
              required
            ></textarea></label
          ><button
            class="button primary"
            type="submit"
            :disabled="!session.sensitiveActive || triggerCreateBusy"
            :aria-busy="triggerCreateBusy"
          >
            <Plus :size="16" />{{
              triggerCreateBusy ? "创建中…" : "创建停用触发器"
            }}
          </button>
        </form>
        <div class="table-shell">
          <table>
            <thead>
              <tr>
                <th>触发器</th>
                <th>工作流版本</th>
                <th>条件</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!triggers.length">
                <td colspan="4" class="empty-cell">暂无触发器</td>
              </tr>
              <tr v-for="trigger in triggers" :key="trigger.id">
                <td>
                  <strong>{{ trigger.name }}</strong>
                  <span
                    v-if="trigger.conflictingTriggerIds.length"
                    class="trigger-conflict-note"
                    ><ShieldAlert :size="13" />可能与
                    {{ conflictingTriggerNames(trigger) }} 同时匹配</span
                  >
                </td>
                <td>v{{ trigger.workflowVersion }}</td>
                <td class="mono compact-json">
                  {{ JSON.stringify(trigger.conditions) }}
                </td>
                <td>
                  <button
                    class="switch-button"
                    :class="{ active: trigger.enabled }"
                    :disabled="
                      !session.sensitiveActive ||
                      triggerToggleBusyIds.has(trigger.id)
                    "
                    :aria-busy="triggerToggleBusyIds.has(trigger.id)"
                    @click="toggleTrigger(trigger)"
                  >
                    <ToggleLeft :size="16" />{{
                      triggerToggleBusyIds.has(trigger.id)
                        ? "处理中…"
                        : trigger.enabled
                          ? "已启用"
                          : "已停用"
                    }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </main>
</template>
