<script setup lang="ts">
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import {
  Boxes,
  ClipboardCopy,
  Download,
  FileJson,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  ToggleLeft,
  Trash2,
  Upload,
  X,
} from "@lucide/vue";
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import WorkflowEditor from "../components/workflow/WorkflowEditor.vue";
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
interface TriggerPreviewResult {
  matched: boolean;
  checks: Array<{
    field:
      "chat" | "sender" | "contentType" | "text" | "timeWindow" | "isFromMe";
    matched: boolean;
  }>;
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
    !window.confirm(`确认删除工作流「${workflow.name}」？`)
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
const versions = ref<WorkflowVersion[]>([]);
const triggers = ref<Trigger[]>([]);
const chats = ref<Array<{ providerChatId: string; displayName: string }>>([]);
const aiRoutes = ref<AiRoute[]>([]);
const actionBlocks = ref<any[]>([]);
const selectedWorkflowId = ref("");
const busy = ref(false);
const message = ref("");
const messageIsError = ref(false);
const workflowCreateBusy = ref(false);
const versionCreateBusy = ref(false);
const publishBusy = ref(false);
const triggerCreateBusy = ref(false);
const triggerEditId = ref<string | null>(null);
const triggerDeleteBusyIds = reactive(new Set<string>());
const workflowToggleBusyIds = reactive(new Set<string>());
const workflowDeleteBusyIds = reactive(new Set<string>());
const workflowExportBusyIds = reactive(new Set<string>());
const triggerToggleBusyIds = reactive(new Set<string>());
let versionsRequestId = 0;
const createForm = reactive({ name: "", definition: "" });
const versionDefinition = ref("");
const selectedDefinition = computed(() => {
  try {
    return versionDefinition.value
      ? JSON.parse(versionDefinition.value)
      : undefined;
  } catch {
    return undefined;
  }
});
const triggerForm = reactive({
  name: "",
  workflowId: "",
  chatId: "",
  textKind: "prefix",
  textValue: "",
  contentType: "text",
});
function startTriggerEdit(trigger: Trigger) {
  const conditions = (trigger.conditions ?? {}) as any;
  triggerEditId.value = trigger.id;
  triggerForm.name = trigger.name;
  triggerForm.workflowId = trigger.workflowId;
  triggerForm.chatId = conditions.chatIds?.[0] ?? "";
  triggerForm.textKind = conditions.text?.kind ?? "prefix";
  triggerForm.textValue = conditions.text?.value ?? "";
  triggerForm.contentType = conditions.contentTypes?.[0] ?? "";
}
function cancelTriggerEdit() {
  triggerEditId.value = null;
  triggerForm.name = "";
  triggerForm.workflowId = "";
  triggerForm.chatId = "";
  triggerForm.textValue = "";
  triggerForm.textKind = "prefix";
  triggerForm.contentType = "text";
}
function triggerConditions() {
  return {
    chatIds: triggerForm.chatId ? [triggerForm.chatId] : [],
    senderIds: [],
    contentTypes: triggerForm.contentType ? [triggerForm.contentType] : [],
    text: triggerForm.textValue
      ? {
          kind: triggerForm.textKind,
          value: triggerForm.textValue,
          caseSensitive: false,
        }
      : null,
    timeWindow: null,
  };
}
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
const aiFlowForm = reactive({
  providerRouteId: "",
  messageLimit: 10,
  characterLimit: 6000,
  includeFromMe: true,
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
const importMode = ref<"create" | "new-version">("create");
const importTargetWorkflowId = ref("");
const importSelections = reactive<Record<string, string>>({});

function openImport() {
  importOpen.value = true;
  importPreview.value = null;
  importJson.value = "";
  importMode.value = "create";
  importTargetWorkflowId.value = "";
  for (const key of Object.keys(importSelections)) delete importSelections[key];
}

async function loadImportFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  importJson.value = await file.text();
  importPreview.value = null;
}

async function previewImport() {
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
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    importBusy.value = false;
  }
}

async function commitImport() {
  if (!importPreview.value?.valid || !importPreview.value.previewToken) return;
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
    message.value = errorMessage(cause);
    messageIsError.value = true;
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
    const version =
      workflowVersions.find((item) => item.status === "validated") ??
      workflowVersions.find(
        (item) => item.version === workflow.publishedVersion,
      ) ??
      workflowVersions[0];
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
function conditionSummary(conditions: any): string {
  const chat = conditions?.chatIds?.length
    ? `指定聊天 ${conditions.chatIds.length} 个`
    : "所有聊天";
  const text = conditions?.text?.value
    ? `${conditions.text.kind}: ${conditions.text.value}`
    : "任意文本";
  const types = conditions?.contentTypes?.length
    ? conditions.contentTypes.join("、")
    : "全部消息类型";
  return `${chat} · ${text} · ${types}`;
}

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
    [
      workflows.value,
      triggers.value,
      aiRoutes.value,
      actionBlocks.value,
      chats.value,
    ] = await Promise.all([
      apiRequest<Workflow[]>("/api/v1/workflows"),
      apiRequest<Trigger[]>("/api/v1/triggers"),
      apiRequest<AiRoute[]>("/api/v1/ai/routes"),
      apiRequest<any[]>("/api/v1/workflows/action-blocks"),
      apiAllPages<{ providerChatId: string; displayName: string }>(
        "/api/v1/chats?limit=100",
      ),
    ]);
    actionBlocks.value = actionBlocks.value.map((block) =>
      block.type === "ai-chat" || block.type === "load-context"
        ? {
            ...block,
            config: block.config.map((item: any) =>
              item.name === "providerRouteId" ||
              item.name === "summaryProviderRouteId"
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
  }
}

function aiConversationDefinition(name: string) {
  if (!aiFlowForm.providerRouteId) {
    throw new Error("请先在 AI 服务中创建并选择一个 Provider 路由。");
  }
  return {
    schemaVersion: "1",
    name: name || "AI conversation workflow",
    startNodeId: "load-context",
    maxSteps: 16,
    nodes: [
      {
        id: "load-context",
        type: "load-context",
        version: 1,
        config: {
          messageLimit: aiFlowForm.messageLimit,
          characterLimit: aiFlowForm.characterLimit,
          includeFromMe: aiFlowForm.includeFromMe,
        },
        onSuccess: "ask-ai",
        onFailure: "failed",
      },
      {
        id: "ask-ai",
        type: "ai-chat",
        version: 1,
        config: {
          providerRouteId: aiFlowForm.providerRouteId,
          systemPrompt: aiFlowForm.systemPrompt,
          promptTemplate: aiFlowForm.promptTemplate,
          includeLoadedContext: true,
          maxOutputTokens: 1024,
          maxOutputCharacters: 4000,
          temperature: null,
          outputFormat: "text",
          outputVariable: "aiReply",
        },
        onSuccess: "send-reply",
        onFailure: "failed",
      },
      {
        id: "send-reply",
        type: "reply",
        version: 1,
        config: {
          text: aiFlowForm.replyTemplate,
          replyToSourceMessage: false,
          retry: { maxAttempts: 2, initialDelayMs: 250 },
        },
        onSuccess: "completed",
        onFailure: "failed",
      },
      {
        id: "completed",
        type: "end",
        version: 1,
        config: { result: "succeeded" },
      },
      {
        id: "failed",
        type: "end",
        version: 1,
        config: { result: "skipped" },
      },
    ],
  };
}

function fillAiConversationDefinition(target: "create" | "version") {
  try {
    const selectedName =
      workflows.value.find((item) => item.id === selectedWorkflowId.value)
        ?.name ?? "AI conversation workflow";
    const definition = aiConversationDefinition(
      target === "create" ? createForm.name : selectedName,
    );
    const value = JSON.stringify(definition, null, 2);
    if (target === "create") createForm.definition = value;
    else versionDefinition.value = value;
    message.value =
      "已生成“聊天上下文 → AI → 群聊回复”定义，可继续编辑 JSON 或直接保存。";
    messageIsError.value = false;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
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
    const activated = await apiRequest<WorkflowVersion>(
      `/api/v1/workflows/${created.workflowId}/versions/${created.version}/publish`,
      { method: "POST" },
    );
    createForm.name = "";
    createForm.definition = "";
    await load();
    selectedWorkflowId.value = created.workflowId;
    versions.value = [activated];
    versionDefinition.value = JSON.stringify(activated.definition, null, 2);
    workflows.value = workflows.value.map((item) =>
      item.id === activated.workflowId
        ? {
            ...item,
            status: "active",
            publishedVersion: activated.version,
            updatedAt: new Date().toISOString(),
          }
        : item,
    );
    message.value = `已创建并启用工作流「${activated.workflowName}」v${activated.version}。`;
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
    const activated = await apiRequest<WorkflowVersion>(
      `/api/v1/workflows/${created.workflowId}/versions/${created.version}/publish`,
      { method: "POST" },
    );
    versions.value = [activated, ...versions.value];
    versionDefinition.value = JSON.stringify(activated.definition, null, 2);
    workflows.value = workflows.value.map((item) =>
      item.id === activated.workflowId
        ? {
            ...item,
            status: "active",
            publishedVersion: activated.version,
            updatedAt: new Date().toISOString(),
          }
        : item,
    );
    message.value = `工作流「${activated.workflowName}」已保存并生效（v${activated.version}）。`;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    versionCreateBusy.value = false;
  }
}

async function publish() {
  if (!latestCandidate.value || publishBusy.value) return;
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
          conditions: triggerConditions(),
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
  if (triggerCreateBusy.value) return;
  const workflow = workflows.value.find(
    (item) => item.id === triggerForm.workflowId,
  );
  if (!workflow?.publishedVersion) return;
  triggerCreateBusy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    const payload = {
      name: triggerForm.name,
      workflowId: workflow.id,
      workflowVersion: workflow.publishedVersion,
      conditions: triggerConditions(),
      includeFromMe: false,
      enabled: false,
    };
    const created = triggerEditId.value
      ? await apiRequest<Trigger>(`/api/v1/triggers/${triggerEditId.value}`, {
          method: "PUT",
          body: jsonBody(payload),
        })
      : await apiRequest<Trigger>("/api/v1/triggers", {
          method: "POST",
          body: jsonBody(payload),
        });
    if (triggerEditId.value) {
      triggers.value = triggers.value.map((item) =>
        item.id === created.id
          ? { ...created, conflictingTriggerIds: item.conflictingTriggerIds }
          : item,
      );
      message.value = `触发器「${created.name}」已更新。`;
      cancelTriggerEdit();
      return;
    }
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

async function deleteTrigger(trigger: Trigger) {
  if (
    triggerDeleteBusyIds.has(trigger.id) ||
    !window.confirm(`确认删除触发器「${trigger.name}」？`)
  )
    return;
  triggerDeleteBusyIds.add(trigger.id);
  try {
    await apiRequest(`/api/v1/triggers/${trigger.id}`, { method: "DELETE" });
    triggers.value = triggers.value.filter((item) => item.id !== trigger.id);
    if (triggerEditId.value === trigger.id) cancelTriggerEdit();
    message.value = `触发器「${trigger.name}」已删除。`;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    triggerDeleteBusyIds.delete(trigger.id);
  }
}

async function toggleTrigger(trigger: Trigger) {
  if (triggerToggleBusyIds.has(trigger.id)) return;
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
        <h2>流程编排</h2>
      </div>
      <nav>
        <button class="active" type="button"><Boxes :size="18" />工作流</button>
      </nav>
      <div class="sidebar-note">
        拖入动作块、连接端口并保存，工作流会立即生效。
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
            <p class="card-kicker">VERSIONED WORKFLOWS</p>
            <h1>工作流</h1>
          </div>
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
        <div class="workflow-ai-tools">
          <span><FileJson :size="16" />AI 编写资源</span>
          <button
            class="button tiny secondary"
            type="button"
            @click="copyWorkflowResource('schema')"
          >
            <ClipboardCopy :size="14" />Schema
          </button>
          <button
            class="button tiny secondary"
            type="button"
            @click="copyWorkflowResource('guide')"
          >
            <ClipboardCopy :size="14" />编写指南
          </button>
          <button
            class="button tiny secondary"
            type="button"
            @click="copyWorkflowResource('catalog')"
          >
            <ClipboardCopy :size="14" />Binding Catalog
          </button>
          <button
            class="button tiny secondary"
            type="button"
            @click="copyWorkflowResource('prompt')"
          >
            <ClipboardCopy :size="14" />标准提示词
          </button>
        </div>
        <WorkflowEditor
          v-if="false"
          :blocks="actionBlocks"
          :workflow-name="createForm.name"
          :definition="selectedDefinition"
          @create="
            (_name, definition) => {
              createForm.name = _name;
              createForm.definition = JSON.stringify(definition);
              createWorkflow();
            }
          "
          @version="
            (_name, definition) => {
              versionDefinition = JSON.stringify(definition);
              createVersion();
            }
          "
        />
        <form
          v-if="false"
          class="settings-form boxed-form"
          @submit.prevent="fillAiConversationDefinition('create')"
        >
          <h3><GitBranch :size="18" />AI 对话流程生成器</h3>
          <p class="panel-description">
            生成“读取当前聊天最近消息 → 将上下文和提示词交给 AI → 把 AI
            输出发送回当前群聊”的可执行工作流。聊天记录会作为独立消息注入 AI
            上下文，提示词还可使用
            <code>&#123;&#123;message.text&#125;&#125;</code>
            等触发消息变量。
          </p>
          <div class="field-grid">
            <label
              ><span>AI Provider 路由</span
              ><select v-model="aiFlowForm.providerRouteId" required>
                <option value="">请先配置路由</option>
                <option
                  v-for="route in aiRoutes"
                  :key="route.id"
                  :value="route.id"
                >
                  {{ route.name }}{{ route.enabled ? "" : "（已停用）" }}
                </option>
              </select></label
            ><label
              ><span>最近消息条数</span
              ><input
                v-model.number="aiFlowForm.messageLimit"
                type="number"
                min="1"
                max="50"
                required /></label
            ><label
              ><span>上下文字数上限</span
              ><input
                v-model.number="aiFlowForm.characterLimit"
                type="number"
                min="100"
                max="20000"
                required /></label
            ><label class="checkbox-field"
              ><input v-model="aiFlowForm.includeFromMe" type="checkbox" /><span
                >包含自己/机器人发送的消息</span
              ></label
            ><label class="wide-field"
              ><span>System Prompt</span
              ><textarea v-model="aiFlowForm.systemPrompt" rows="3"></textarea>
            </label>
            <label class="wide-field"
              ><span>任务提示词</span
              ><textarea
                v-model="aiFlowForm.promptTemplate"
                rows="4"
                required
              ></textarea>
            </label>
            <label class="wide-field"
              ><span>发送消息模板</span
              ><input v-model="aiFlowForm.replyTemplate" required
            /></label>
          </div>
          <div class="form-actions">
            <button class="button secondary" type="submit">
              填充到新工作流
            </button>
            <button
              class="button secondary"
              type="button"
              :disabled="!selectedWorkflowId"
              @click="fillAiConversationDefinition('version')"
            >
              填充到当前候选版本
            </button>
          </div>
        </form>
        <div v-if="false" class="two-column-forms">
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
                :disabled="!latestCandidate || publishBusy"
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
                <th>匹配方式</th>
                <th>匹配内容</th>
                <th>更新时间</th>
                <th class="workflow-actions-heading">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!workflows.length">
                <td colspan="7" class="empty-cell">暂无工作流</td>
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
                <td>{{ new Date(workflow.updatedAt).toLocaleString() }}</td>
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
                      :class="{ active: workflow.status === 'active' }"
                      type="button"
                      :disabled="
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
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <div
        v-if="importOpen"
        class="workflow-import-backdrop"
        @click.self="importOpen = false"
      >
        <section
          class="workflow-import-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="导入工作流"
        >
          <div class="panel-head">
            <div>
              <p class="card-kicker">AI FRIENDLY IMPORT</p>
              <h2>导入工作流</h2>
            </div>
            <button
              class="icon-button"
              type="button"
              title="关闭"
              @click="importOpen = false"
            >
              <X :size="18" />
            </button>
          </div>
          <label class="workflow-import-file">
            <span>上传 .bubblepilot-workflow.json</span>
            <input
              type="file"
              accept="application/json,.json"
              @change="loadImportFile"
            />
          </label>
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
              <FileJson :size="16" />{{ importBusy ? "校验中…" : "预览并校验" }}
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
        </section>
      </div>
      <section v-show="false" id="triggers" class="admin-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">BOT EVENTS</p>
            <h2>Bot 触发器</h2>
          </div>
          <span class="state-badge">AND 条件组合</span>
        </div>
        <div class="trigger-layout">
          <div class="trigger-create-column">
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
                  ><input
                    v-model.trim="triggerPreviewForm.providerChatId"
                    required
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
                  ><span>样本文本</span
                  ><input v-model="triggerPreviewForm.text"
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
                  <strong>{{
                    triggerPreview.matched ? "匹配" : "不匹配"
                  }}</strong>
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
            <form
              class="inline-create-form trigger-create-form"
              @submit.prevent="createTrigger"
            >
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
              ><label
                ><span>目标聊天</span
                ><select v-model="triggerForm.chatId">
                  <option value="">所有聊天</option>
                  <option
                    v-for="chat in chats"
                    :key="chat.providerChatId"
                    :value="chat.providerChatId"
                  >
                    {{ chat.displayName }}
                  </option>
                </select></label
              ><label
                ><span>文本匹配</span
                ><select v-model="triggerForm.textKind">
                  <option value="prefix">以此前缀开头</option>
                  <option value="contains">包含文本</option>
                  <option value="exact">完全匹配</option>
                  <option value="regex">正则表达式</option>
                </select></label
              ><label
                ><span>匹配内容（可选）</span
                ><input
                  v-model.trim="triggerForm.textValue"
                  placeholder="例如 /sum" /></label
              ><label
                ><span>消息类型</span
                ><select v-model="triggerForm.contentType">
                  <option value="">全部类型</option>
                  <option value="text">文本</option>
                  <option value="attachment">附件</option>
                  <option value="mixed">混合</option>
                </select></label
              ><button
                class="button primary"
                type="submit"
                :disabled="triggerCreateBusy"
                :aria-busy="triggerCreateBusy"
              >
                <Plus :size="16" />{{
                  triggerCreateBusy
                    ? triggerEditId
                      ? "保存中…"
                      : "创建中…"
                    : triggerEditId
                      ? "保存修改"
                      : "创建停用触发器"
                }}
              </button>
              <button
                v-if="triggerEditId"
                class="button secondary"
                type="button"
                @click="cancelTriggerEdit"
              >
                取消编辑
              </button>
            </form>
          </div>
          <div class="trigger-manage-column">
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
                    <td>
                      {{ conditionSummary(trigger.conditions) }}
                    </td>
                    <td>
                      <div class="row-actions">
                        <button
                          class="button tiny secondary"
                          type="button"
                          @click="startTriggerEdit(trigger)"
                        >
                          编辑
                        </button>
                        <button
                          class="button tiny danger"
                          type="button"
                          :disabled="triggerDeleteBusyIds.has(trigger.id)"
                          @click="deleteTrigger(trigger)"
                        >
                          删除
                        </button>
                      </div>
                      <button
                        class="switch-button"
                        :class="{ active: trigger.enabled }"
                        :disabled="triggerToggleBusyIds.has(trigger.id)"
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
          </div>
        </div>
      </section>
    </div>
  </main>
</template>
