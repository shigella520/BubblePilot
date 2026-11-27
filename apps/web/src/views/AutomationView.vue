<script setup lang="ts">
import CopyableId from "../components/CopyableId.vue";
import ScheduledTaskSettingsPanel from "../components/ScheduledTaskSettingsPanel.vue";
import SectionNavigation from "../components/SectionNavigation.vue";
import ScheduledTasksPanel from "../components/workflow/ScheduledTasksPanel.vue";
import IdleAuditPanel from "../components/workflow/IdleAuditPanel.vue";
import { confirmAction } from "../services/confirm";
import { partialFailureMessage, settleAll } from "../utils/settle";
import { formatDateTime } from "../utils/format";
import StatusBadge from "../components/StatusBadge.vue";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import {
  CalendarClock,
  ClipboardCopy,
  Download,
  FileJson,
  MessageCircleMore,
  Pencil,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  Upload,
  Workflow as WorkflowIcon,
} from "@lucide/vue";
import { onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { selectWorkflowVersion } from "../utils/workflow-version";
import AdminDetailDialog from "../components/AdminDetailDialog.vue";
import DismissibleMessage from "../components/DismissibleMessage.vue";

import {
  apiAllPages,
  apiRequest,
  errorMessage,
  jsonBody,
  parseJsonObject,
} from "../services/api";

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
interface AiRoute {
  id: string;
  name: string;
  enabled: boolean;
  effectiveProviderIds: string[];
}

const router = useRouter();
function editWorkflow(workflow: Workflow) {
  void router.push(`/automation/${workflow.id}`);
}
function startNewWorkflow() {
  void router.push("/automation/new");
}
async function deleteWorkflow(workflow: Workflow) {
  if (
    workflowDeleteBusyIds.has(workflow.id) ||
    !(await confirmAction(`确认删除工作流「${workflow.name}」？`))
  )
    return;
  workflowDeleteBusyIds.add(workflow.id);
  try {
    await apiRequest(`/api/v1/workflows/${workflow.id}`, { method: "DELETE" });
    workflows.value = workflows.value.filter((item) => item.id !== workflow.id);
    if (selectedWorkflowId.value === workflow.id) {
      selectedWorkflowId.value = "";
      versions.value = [];
      versionDefinition.value = "";
    }
    message.value = `工作流「${workflow.name}」已删除。`;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    workflowDeleteBusyIds.delete(workflow.id);
  }
}
const workflows = ref<Workflow[]>([]);
const roleStatus = ref<{
  workflows: Array<{ workflowId: string; nickname: string | null }>;
} | null>(null);
function roleNickname(id: string) {
  return (
    roleStatus.value?.workflows.find((w) => w.workflowId === id)?.nickname ??
    "未配置角色"
  );
}
const versions = ref<WorkflowVersion[]>([]);
const triggers = ref<Trigger[]>([]);
const chats = ref<Array<{ providerChatId: string; displayName: string }>>([]);
const aiRoutes = ref<AiRoute[]>([]);
const actionBlocks = ref<any[]>([]);
const selectedWorkflowId = ref("");
const busy = ref(false);
/** First load finished; before that the list shows “加载中”, not “暂无”. */
const loaded = ref(false);
const workflowsFailed = ref(false);
const message = ref("");
const messageIsError = ref(false);
const workflowToggleBusyIds = reactive(new Set<string>());
const workflowDeleteBusyIds = reactive(new Set<string>());
const workflowExportBusyIds = reactive(new Set<string>());
let versionsRequestId = 0;
const createForm = reactive({ name: "", definition: "" });
const versionDefinition = ref("");
const aiFlowForm = reactive({
  providerRouteId: "",
  systemPrompt: "你是群聊助手，请严格根据提供的聊天上下文回答。",
  promptTemplate: "请根据前面的聊天记录执行以下任务：\n{{message.text}}",
  replyTemplate: "{{variables.aiReply}}",
});

interface ImportIssue {
  path: string;
  code: string;
  message: string;
  suggestion: string;
}
interface ImportBinding {
  ref: string;
  kind: "aiRoute" | "chat";
  name: string;
  selectedId: string | null;
  status: string;
  candidates: Array<{ id: string; name: string; capabilities: string[] }>;
}
interface ImportPreview {
  valid: boolean;
  normalizedManifest: Record<string, unknown> | null;
  previewToken: string | null;
  expiresAt: string | null;
  bindings: ImportBinding[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
  summary: { name: string; description: string; nodeCount: number } | null;
}

const importOpen = ref(false);
const importJson = ref("");
const importPreview = ref<ImportPreview | null>(null);
const importBusy = ref(false);
const importError = ref("");
const importFilename = ref("");
const importFileInput = ref<HTMLInputElement | null>(null);
const importMode = ref<"create" | "new-version">("create");
const importTargetWorkflowId = ref("");
const importSelections = reactive<Record<string, string>>({});

function closeImport() {
  if (!importBusy.value) importOpen.value = false;
}
function openImport() {
  importError.value = "";
  importFilename.value = "";
  importOpen.value = true;
  importPreview.value = null;
  importJson.value = "";
  importMode.value = "create";
  importTargetWorkflowId.value = "";
  for (const key of Object.keys(importSelections)) delete importSelections[key];
}

async function loadImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || importBusy.value) return;
  importBusy.value = true;
  importError.value = "";
  importPreview.value = null;
  try {
    importJson.value = await file.text();
    importFilename.value = file.name;
  } catch (cause) {
    importError.value = errorMessage(cause);
  } finally {
    input.value = "";
    importBusy.value = false;
  }
}

async function previewImport() {
  if (importBusy.value) return;
  importError.value = "";
  importPreview.value = null;
  importBusy.value = true;
  try {
    const manifest = parseJsonObject(importJson.value);
    importPreview.value = await apiRequest<ImportPreview>(
      "/api/v1/workflows/import/preview",
      {
        method: "POST",
        body: jsonBody({ manifest, bindings: importSelections }),
      },
    );
    for (const binding of importPreview.value.bindings) {
      if (binding.selectedId && !importSelections[binding.ref]) {
        importSelections[binding.ref] = binding.selectedId;
      }
    }
  } catch (cause) {
    importError.value = errorMessage(cause);
  } finally {
    importBusy.value = false;
  }
}

async function commitImport() {
  if (
    importBusy.value ||
    !importPreview.value?.valid ||
    !importPreview.value.previewToken
  )
    return;
  importError.value = "";
  importBusy.value = true;
  try {
    const result = await apiRequest<{
      workflowId: string;
      workflowVersion: number;
    }>("/api/v1/workflows/import", {
      method: "POST",
      body: jsonBody({
        manifest: parseJsonObject(importJson.value),
        previewToken: importPreview.value.previewToken,
        bindings: importSelections,
        mode: importMode.value,
        ...(importMode.value === "new-version"
          ? { targetWorkflowId: importTargetWorkflowId.value }
          : {}),
      }),
    });
    importOpen.value = false;
    await router.push(
      `/automation/${result.workflowId}?version=${result.workflowVersion}`,
    );
  } catch (cause) {
    importError.value = errorMessage(cause);
  } finally {
    importBusy.value = false;
  }
}

async function exportWorkflow(
  workflow: Workflow,
  mode: "portable" | "instance-bound" = "portable",
) {
  if (workflowExportBusyIds.has(workflow.id)) return;
  workflowExportBusyIds.add(workflow.id);
  try {
    const workflowVersions = await apiRequest<WorkflowVersion[]>(
      `/api/v1/workflows/${workflow.id}/versions`,
    );
    const version = selectWorkflowVersion(
      workflowVersions,
      workflow.publishedVersion,
    );
    if (!version) throw new Error("该工作流没有可导出的版本。");
    const manifest = await apiRequest<Record<string, unknown>>(
      `/api/v1/workflows/${workflow.id}/versions/${version.version}/export?mode=${mode}`,
    );
    const blobUrl = URL.createObjectURL(
      new Blob([JSON.stringify(manifest, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = `${workflow.name.replace(/[^a-zA-Z0-9._-]+/gu, "-") || "workflow"}.bubblepilot-workflow.json`;
    anchor.click();
    URL.revokeObjectURL(blobUrl);
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    workflowExportBusyIds.delete(workflow.id);
  }
}

async function copyWorkflowResource(
  kind: "schema" | "guide" | "catalog" | "prompt",
) {
  try {
    const path =
      kind === "schema"
        ? "/api/v1/workflows/schema"
        : kind === "catalog"
          ? "/api/v1/workflows/binding-catalog"
          : "/api/v1/workflows/schema/guide";
    const value = await apiRequest<any>(path);
    const copied = kind === "prompt" ? value.standardPrompt : value;
    await navigator.clipboard.writeText(
      typeof copied === "string" ? copied : JSON.stringify(copied, null, 2),
    );
    message.value = "已复制到剪贴板。";
    messageIsError.value = false;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  }
}

const defaultDefinition = (name: string) =>
  JSON.stringify(
    {
      schemaVersion: "1",
      name: name || "New workflow",
      startNodeId: "end",
      maxSteps: 64,
      nodes: [
        { id: "end", type: "end", version: 1, config: { result: "succeeded" } },
      ],
    },
    null,
    2,
  );

interface WorkflowTextMatchRule {
  triggerId: string;
  triggerName: string;
  method: string;
  content: string;
}

function textMatchMethod(kind: unknown): string {
  switch (kind) {
    case "keyword":
      return "包含关键词";
    case "prefix":
      return "前缀匹配";
    case "regex":
      return "正则表达式";
    default:
      return "任意消息";
  }
}

function workflowTextMatchRules(workflowId: string): WorkflowTextMatchRule[] {
  return triggers.value
    .filter((trigger) => trigger.workflowId === workflowId && trigger.enabled)
    .map((trigger) => {
      const conditions = (trigger.conditions ?? {}) as {
        text?: { kind?: unknown; value?: unknown } | null;
      };
      const value = conditions.text?.value;
      return {
        triggerId: trigger.id,
        triggerName: trigger.name,
        method: textMatchMethod(conditions.text?.kind),
        content:
          typeof value === "string" && value.length > 0 ? value : "全部内容",
      };
    });
}

async function load() {
  busy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    const { values, failed } = await settleAll({
      workflows: () => apiRequest<Workflow[]>("/api/v1/workflows"),
      triggers: () => apiRequest<Trigger[]>("/api/v1/triggers"),
      aiRoutes: () => apiRequest<AiRoute[]>("/api/v1/ai/routes"),
      actionBlocks: () => apiRequest<any[]>("/api/v1/workflows/action-blocks"),
      chats: () =>
        apiAllPages<{ providerChatId: string; displayName: string }>(
          "/api/v1/chats?limit=100",
        ),
      roleStatus: () =>
        apiRequest<{
          workflows: Array<{ workflowId: string; nickname: string | null }>;
        }>("/api/v1/bot-attributions"),
    });
    workflowsFailed.value = !values.workflows;
    if (values.workflows) workflows.value = values.workflows;
    if (values.triggers) triggers.value = values.triggers;
    if (values.aiRoutes) aiRoutes.value = values.aiRoutes;
    if (values.actionBlocks) actionBlocks.value = values.actionBlocks;
    if (values.chats) chats.value = values.chats;
    if (values.roleStatus) roleStatus.value = values.roleStatus;
    if (failed.length) {
      message.value = partialFailureMessage(
        failed,
        {
          workflows: "工作流列表",
          triggers: "触发器",
          aiRoutes: "AI 路由",
          actionBlocks: "动作块",
          chats: "聊天列表",
          roleStatus: "角色信息",
        },
        errorMessage,
      );
      messageIsError.value = true;
    }
    actionBlocks.value = actionBlocks.value.map((block) =>
      block.type === "ai-chat" || block.type === "load-context"
        ? {
            ...block,
            config: block.config.map((item: any) =>
              item.name === "providerRouteId"
                ? {
                    ...item,
                    options: aiRoutes.value.map((route) => ({
                      value: route.id,
                      label: route.name,
                    })),
                  }
                : item,
            ),
          }
        : block,
    );
    if (!aiFlowForm.providerRouteId) {
      aiFlowForm.providerRouteId =
        aiRoutes.value.find(
          (route) => route.enabled && route.effectiveProviderIds.length > 0,
        )?.id ??
        aiRoutes.value[0]?.id ??
        "";
    }
    // Start in create mode. Existing workflows are loaded only after the user
    // explicitly clicks “编辑” in the management list.
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    busy.value = false;
    loaded.value = true;
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

async function toggleWorkflow(workflow: Workflow) {
  if (
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
        <p class="eyebrow">自动化</p>
        <h1>自动化</h1>
      </div>
      <SectionNavigation
        :items="[
          { id: 'workflows', label: '工作流', icon: WorkflowIcon },
          { id: 'scheduled-tasks', label: '定时任务', icon: CalendarClock },
          {
            id: 'scheduled-task-settings',
            label: '定时任务全局设置',
            icon: SlidersHorizontal,
          },
          {
            id: 'idle-conversations',
            label: '空闲主动交流',
            icon: MessageCircleMore,
          },
        ]"
      />
      <div class="sidebar-note">
        拖入动作块、连接端口并保存；启用后才接收消息，已启用的工作流点击「保存并发布」即更新线上版本。
      </div>
    </aside>
    <div class="admin-workspace">
      <DismissibleMessage
        v-if="message"
        :error="messageIsError"
        @close="message = ''"
        >{{ message }}</DismissibleMessage
      >
      <section id="workflows" class="admin-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">版本化工作流</p>
            <h2>工作流</h2>
          </div>
          <details class="dev-resources">
            <summary class="button secondary">
              <FileJson :size="16" />开发者资源
            </summary>
            <div
              class="dev-resources-menu"
              role="group"
              aria-label="复制给 AI 编写工作流的资源"
            >
              <button
                class="button secondary tiny"
                type="button"
                @click="copyWorkflowResource('schema')"
              >
                <ClipboardCopy :size="14" />Schema
              </button>
              <button
                class="button secondary tiny"
                type="button"
                @click="copyWorkflowResource('guide')"
              >
                <ClipboardCopy :size="14" />编写指南
              </button>
              <button
                class="button secondary tiny"
                type="button"
                @click="copyWorkflowResource('catalog')"
              >
                <ClipboardCopy :size="14" />Binding Catalog
              </button>
              <button
                class="button secondary tiny"
                type="button"
                @click="copyWorkflowResource('prompt')"
              >
                <ClipboardCopy :size="14" />标准提示词
              </button>
            </div>
          </details>
          <button class="button secondary" @click="load">
            <RefreshCw :size="16" />刷新
          </button>
          <button class="button secondary" type="button" @click="openImport">
            <Upload :size="16" />导入工作流
          </button>
          <button
            class="button primary"
            type="button"
            @click="startNewWorkflow"
          >
            <Plus :size="16" />新建工作流
          </button>
        </div>
        <div class="table-shell">
          <table>
            <thead>
              <tr>
                <th>工作流</th>
                <th>状态</th>
                <th>已发布</th>
                <th>匹配方式</th>
                <th>匹配内容</th>
                <th>更新时间</th>
                <th class="workflow-actions-heading">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!workflows.length">
                <td colspan="7" class="empty-cell">
                  {{
                    !loaded
                      ? "正在加载工作流…"
                      : workflowsFailed
                        ? "工作流列表加载失败，请点击刷新重试。"
                        : "暂无工作流"
                  }}
                </td>
              </tr>
              <tr v-for="workflow in workflows" :key="workflow.id">
                <td>
                  <strong>{{ workflow.name }}</strong
                  ><span class="keyline"
                    >角色：{{
                      roleStatus ? roleNickname(workflow.id) : "未读取"
                    }}</span
                  ><span class="keyline"
                    >ID <CopyableId :value="workflow.id"
                  /></span>
                </td>
                <td>
                  <StatusBadge domain="workflow" :status="workflow.status" />
                </td>
                <td>
                  {{
                    workflow.publishedVersion
                      ? `v${workflow.publishedVersion}`
                      : "—"
                  }}
                </td>
                <td>
                  <div
                    v-if="workflowTextMatchRules(workflow.id).length"
                    class="workflow-match-list"
                  >
                    <span
                      v-for="rule in workflowTextMatchRules(workflow.id)"
                      :key="rule.triggerId"
                      class="workflow-match-method"
                      :title="rule.triggerName"
                      >{{ rule.method }}</span
                    >
                  </div>
                  <span v-else class="keyline">未启用触发器</span>
                </td>
                <td>
                  <div
                    v-if="workflowTextMatchRules(workflow.id).length"
                    class="workflow-match-list"
                  >
                    <code
                      v-for="rule in workflowTextMatchRules(workflow.id)"
                      :key="rule.triggerId"
                      class="workflow-match-content"
                      :title="`${rule.triggerName}：${rule.content}`"
                      >{{ rule.content }}</code
                    >
                  </div>
                  <span v-else>—</span>
                </td>
                <td>{{ formatDateTime(workflow.updatedAt) }}</td>
                <td>
                  <div class="workflow-row-actions">
                    <button
                      class="button tiny secondary"
                      type="button"
                      @click="editWorkflow(workflow)"
                    >
                      <Pencil :size="14" />编辑
                    </button>
                    <button
                      class="button tiny secondary"
                      type="button"
                      :disabled="workflowExportBusyIds.has(workflow.id)"
                      @click="exportWorkflow(workflow)"
                    >
                      <Download :size="14" />导出
                    </button>
                    <button
                      class="button tiny danger-ghost"
                      type="button"
                      :disabled="workflowDeleteBusyIds.has(workflow.id)"
                      @click="deleteWorkflow(workflow)"
                    >
                      <Trash2 :size="14" />删除
                    </button>
                    <button
                      class="switch-button"
                      role="switch"
                      :aria-checked="workflow.status === 'active'"
                      :class="{ active: workflow.status === 'active' }"
                      type="button"
                      :disabled="
                        workflow.publishedVersion === null ||
                        workflowToggleBusyIds.has(workflow.id)
                      "
                      :aria-busy="workflowToggleBusyIds.has(workflow.id)"
                      :title="
                        workflow.publishedVersion === null
                          ? '尚无已保存版本：请先在画布中保存，再启用'
                          : undefined
                      "
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
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <AdminDetailDialog
        v-if="importOpen"
        title="导入工作流"
        @close="closeImport"
      >
        <div class="workflow-import-dialog" :aria-busy="importBusy">
          <p class="panel-description">
            选择工作流 JSON
            文件，或粘贴内容进行预览校验。导入后为候选版本，不会自动启用。
          </p>
          <DismissibleMessage
            v-if="importError"
            error
            @close="importError = ''"
            >{{ importError }}</DismissibleMessage
          >
          <div class="workflow-import-file">
            <FileJson :size="28" aria-hidden="true" />
            <div>
              <strong>{{ importFilename || "选择工作流文件" }}</strong
              ><small>支持 .bubblepilot-workflow.json 或 .json 文件</small>
            </div>
            <input
              ref="importFileInput"
              type="file"
              accept="application/json,.json"
              hidden
              :disabled="importBusy"
              @change="loadImportFile"
            />
            <button
              type="button"
              class="button secondary"
              :disabled="importBusy"
              @click="importFileInput?.click()"
            >
              <Upload :size="16" />{{
                importFilename ? "重新选择" : "选择文件"
              }}
            </button>
          </div>
          <fieldset class="workflow-import-fields" :disabled="importBusy">
            <label>
              <span>或粘贴 Manifest JSON</span>
              <textarea
                v-model="importJson"
                rows="13"
                spellcheck="false"
                @input="importPreview = null"
              ></textarea>
            </label>
            <div class="form-actions">
              <button
                class="button secondary"
                type="button"
                :disabled="!importJson || importBusy"
                @click="previewImport"
              >
                <FileJson :size="16" />{{
                  importBusy ? "校验中…" : "预览并校验"
                }}
              </button>
            </div>
            <template v-if="importPreview">
              <div v-if="importPreview.summary" class="workflow-import-summary">
                <strong>{{ importPreview.summary.name }}</strong>
                <span>{{ importPreview.summary.nodeCount }} 个节点</span>
                <p v-if="importPreview.summary.description">
                  {{ importPreview.summary.description }}
                </p>
              </div>
              <div
                v-if="importPreview.errors.length"
                class="workflow-import-issues"
              >
                <article
                  v-for="issue in importPreview.errors"
                  :key="`${issue.path}:${issue.code}`"
                >
                  <code>{{ issue.path || "/" }}</code>
                  <strong>{{ issue.message }}</strong>
                  <span>{{ issue.suggestion }}</span>
                </article>
              </div>
              <div
                v-if="importPreview.bindings.length"
                class="workflow-import-bindings"
              >
                <label
                  v-for="binding in importPreview.bindings"
                  :key="binding.ref"
                >
                  <span
                    >{{ binding.kind === "aiRoute" ? "AI 路由" : "聊天" }} ·
                    {{ binding.name }}</span
                  >
                  <select
                    v-model="importSelections[binding.ref]"
                    @change="previewImport"
                  >
                    <option value="">请选择绑定</option>
                    <option
                      v-for="candidate in binding.candidates"
                      :key="candidate.id"
                      :value="candidate.id"
                    >
                      {{ candidate.name
                      }}{{
                        candidate.capabilities.length
                          ? ` · ${candidate.capabilities.join(", ")}`
                          : ""
                      }}
                    </option>
                  </select>
                </label>
              </div>
              <div v-if="importPreview.valid" class="workflow-import-commit">
                <label
                  ><span>导入方式</span
                  ><select v-model="importMode">
                    <option value="create">创建新工作流</option>
                    <option value="new-version">添加到已有工作流</option>
                  </select></label
                >
                <label v-if="importMode === 'new-version'"
                  ><span>目标工作流</span
                  ><select v-model="importTargetWorkflowId">
                    <option value="">请选择</option>
                    <option
                      v-for="workflow in workflows"
                      :key="workflow.id"
                      :value="workflow.id"
                    >
                      {{ workflow.name }}
                    </option>
                  </select></label
                >
                <p>导入只创建候选版本，不会自动发布或启用。</p>
                <button
                  class="button primary"
                  type="button"
                  :disabled="
                    importBusy ||
                    (importMode === 'new-version' && !importTargetWorkflowId)
                  "
                  @click="commitImport"
                >
                  <Upload :size="16" />{{ importBusy ? "导入中…" : "确认导入" }}
                </button>
              </div>
            </template>
          </fieldset>
        </div>
      </AdminDetailDialog>
      <ScheduledTasksPanel id="scheduled-tasks" />
      <ScheduledTaskSettingsPanel />
      <IdleAuditPanel id="idle-conversations" />
    </div>
  </main>
</template>
