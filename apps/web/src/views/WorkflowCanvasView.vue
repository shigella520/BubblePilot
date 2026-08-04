<script setup lang="ts">
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
import { ArrowLeft, Check, LoaderCircle, Power, TestTube2 } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import DismissibleMessage from "../components/DismissibleMessage.vue";
import WorkflowEditor from "../components/workflow/WorkflowEditor.vue";
import { apiRequest, errorMessage } from "../services/api";

const route = useRoute();
const router = useRouter();
const workflowId = computed(() => String(route.params.workflowId ?? ""));
// `/automation/new` is a static route, so it has no `workflowId` param.
// Check the full route as well to avoid treating a new workflow as a missing
// existing workflow and showing a misleading not-found error.
const isNew = computed(
  () => route.path === "/automation/new" || workflowId.value === "new",
);
const blocks = ref<any[]>([]);
const workflowName = ref("");
const definition = ref<any | undefined>(undefined);
const workflowStatus = ref("draft");
const publishedVersion = ref<number | null>(null);
const candidateVersion = ref<number | null>(null);
const busy = ref(false);
const message = ref("");
const messageIsError = ref(false);
const saveState = ref<"saved" | "dirty" | "saving" | "error">("saved");

interface AiRouteOption {
  id: string;
  name: string;
}

interface ChatOption {
  providerChatId: string;
  displayName: string;
}

function enrichActionBlocks(
  actionBlocks: any[],
  aiRoutes: AiRouteOption[],
  chats: ChatOption[],
) {
  return actionBlocks.map((block) => ({
    ...block,
    config: block.config.map((item: any) => {
      if (block.type === "ai-chat" && item.name === "providerRouteId") {
        return {
          ...item,
          options: aiRoutes.map((aiRoute) => ({
            value: aiRoute.id,
            label: aiRoute.name,
          })),
        };
      }
      if (block.type === "message-trigger" && item.name === "chatIds") {
        return {
          ...item,
          options: chats.map((chat) => ({
            value: chat.providerChatId,
            label: chat.displayName || chat.providerChatId,
          })),
        };
      }
      return item;
    }),
  }));
}

const versionDefinition = async () => {
  if (isNew.value) return;
  const versions = await apiRequest<any[]>(
    `/api/v1/workflows/${workflowId.value}/versions`,
  );
  const candidate =
    versions.find((item) => item.status === "validated") ?? versions[0];
  if (candidate) {
    workflowName.value = candidate.workflowName;
    definition.value = candidate.definition;
    candidateVersion.value = candidate.version;
  }
};

async function load() {
  busy.value = true;
  try {
    const [actionBlocks, aiRoutes, chats] = await Promise.all([
      apiRequest<any[]>("/api/v1/workflows/action-blocks"),
      apiRequest<AiRouteOption[]>("/api/v1/ai/routes"),
      apiRequest<ChatOption[]>("/api/v1/chats?limit=100"),
    ]);
    blocks.value = enrichActionBlocks(actionBlocks, aiRoutes, chats);
    if (!isNew.value) {
      const workflows = await apiRequest<any[]>("/api/v1/workflows");
      const workflow = workflows.find((item) => item.id === workflowId.value);
      if (!workflow) throw new Error("工作流不存在或已删除。");
      workflowName.value = workflow.name;
      workflowStatus.value = workflow.status;
      publishedVersion.value = workflow.publishedVersion;
      await versionDefinition();
    }
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    busy.value = false;
  }
}

async function create(name: string, nextDefinition: any) {
  saveState.value = "saving";
  try {
    const version = await apiRequest<any>("/api/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: name || "新工作流",
        definition: nextDefinition,
      }),
      headers: { "content-type": "application/json" },
    });
    message.value = "工作流已保存，请在顶部启用。";
    messageIsError.value = false;
    saveState.value = "saved";
    candidateVersion.value = version.version;
    definition.value = nextDefinition;
    await router.replace(`/automation/${version.workflowId}`);
  } catch (cause) {
    saveState.value = "error";
    message.value = errorMessage(cause);
    messageIsError.value = true;
  }
}

async function saveVersion(name: string, nextDefinition: any) {
  if (isNew.value) return create(name, nextDefinition);
  saveState.value = "saving";
  try {
    const version = await apiRequest<any>(
      `/api/v1/workflows/${workflowId.value}/versions`,
      {
        method: "POST",
        body: JSON.stringify({ definition: nextDefinition }),
        headers: { "content-type": "application/json" },
      },
    );
    candidateVersion.value = version.version;
    workflowName.value = name;
    saveState.value = "saved";
    message.value = "已保存新版本，工作流仍保持当前启用状态。";
    messageIsError.value = false;
  } catch (cause) {
    saveState.value = "error";
    message.value = errorMessage(cause);
    messageIsError.value = true;
  }
}

async function toggleEnabled() {
  if (isNew.value || candidateVersion.value === null) {
    message.value = "请先保存工作流，再启用。";
    messageIsError.value = true;
    return;
  }
  try {
    if (
      workflowStatus.value !== "active" &&
      candidateVersion.value !== publishedVersion.value
    ) {
      await apiRequest(
        `/api/v1/workflows/${workflowId.value}/versions/${candidateVersion.value}/publish`,
        {
          method: "POST",
        },
      );
      publishedVersion.value = candidateVersion.value;
    }
    const next = await apiRequest<any>(
      `/api/v1/workflows/${workflowId.value}/enabled`,
      {
        method: "PATCH",
        body: JSON.stringify({ enabled: workflowStatus.value !== "active" }),
        headers: { "content-type": "application/json" },
      },
    );
    workflowStatus.value = next.status;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  }
}

function testWorkflow() {
  message.value =
    "测试执行面板将在下一步接入真实节点模拟器。当前可先保存并启用后用测试消息验证。";
  messageIsError.value = false;
}
function markDirty() {
  if (saveState.value !== "saving") saveState.value = "dirty";
}

onMounted(load);
</script>

<template>
  <main class="workflow-canvas-page">
    <header class="workflow-canvas-header">
      <button
        class="icon-button"
        type="button"
        title="返回工作流列表"
        @click="router.push('/automation')"
      >
        <ArrowLeft :size="18" />
      </button>
      <div class="workflow-canvas-title">
        <span class="eyebrow">WORKFLOW EDITOR</span>
        <input
          v-model="workflowName"
          maxlength="120"
          placeholder="未命名工作流"
        />
      </div>
      <span class="workflow-save-state" :class="saveState">
        <LoaderCircle v-if="saveState === 'saving'" :size="14" />
        <Check v-else :size="14" />
        {{
          saveState === "saving"
            ? "保存中"
            : saveState === "error"
              ? "保存失败"
              : saveState === "dirty"
                ? "有未保存修改"
                : "已保存"
        }}
      </span>
      <div class="workflow-canvas-actions">
        <button class="button secondary" type="button" @click="testWorkflow">
          <TestTube2 :size="16" />测试执行
        </button>
        <button
          class="button secondary"
          type="button"
          :disabled="isNew || candidateVersion === null"
          @click="toggleEnabled"
        >
          <Power :size="16" />{{
            workflowStatus === "active" ? "停用" : "启用"
          }}
        </button>
      </div>
    </header>
    <DismissibleMessage
      v-if="message"
      :error="messageIsError"
      @close="message = ''"
      >{{ message }}</DismissibleMessage
    >
    <section v-if="!busy" class="workflow-canvas-main">
      <WorkflowEditor
        :blocks="blocks"
        :workflow-name="workflowName"
        :definition="definition"
        @create="create"
        @version="saveVersion"
        @change="markDirty"
      />
    </section>
    <div v-else class="loading-screen">正在加载工作流…</div>
  </main>
</template>
