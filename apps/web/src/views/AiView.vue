<script setup lang="ts">
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Plus,
  RefreshCw,
  Route,
  Save,
  TestTube2,
  Trash2,
} from "@lucide/vue";
import { computed, onMounted, reactive, ref } from "vue";

import {
  apiRequest,
  errorMessage,
  jsonBody,
  parseJsonObject,
} from "../services/api";

interface Provider {
  id: string;
  name: string;
  apiKind: "chat-completions" | "responses";
  baseUrl: string;
  model: string;
  secretConfigured: boolean;
  parameters: Record<string, string | number | boolean>;
  requestTimeoutMs: number;
  enabled: boolean;
  sortOrder: number;
  version: number;
  health: {
    state: string;
    consecutiveFailures: number;
    degradedUntil: string | null;
    lastErrorCode: string | null;
  };
}
interface AiRoute {
  id: string;
  name: string;
  providerIds: string[];
  configuredProviderIds: string[];
  effectiveProviderIds: string[];
  unavailableProviderIds: string[];
  fallbackEnabled: boolean;
  retryPolicy: { maxRounds: number; initialDelayMs: number };
  degradePolicy: { failureThreshold: number; cooldownMs: number };
  enabled: boolean;
  version: number;
}
interface ProviderForm {
  id: string;
  expectedVersion: number;
  name: string;
  apiKind: Provider["apiKind"];
  baseUrl: string;
  model: string;
  secret: string;
  parameters: string;
  requestTimeoutMs: number;
  enabled: boolean;
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}
const providers = ref<Provider[]>([]);
const routes = ref<AiRoute[]>([]);
const message = ref("");
const messageIsError = ref(false);
const busy = ref(false);
const draggedId = ref<string | null>(null);
const providerToggleBusyIds = reactive(new Set<string>());
const providerTestBusyIds = reactive(new Set<string>());
const providerResetBusyIds = reactive(new Set<string>());
const providerDeleteBusyIds = reactive(new Set<string>());
const providerOrderBusy = ref(false);
const providerFormBusy = ref(false);
const routeFormBusy = ref(false);
const routeToggleBusyIds = reactive(new Set<string>());
const routeDeleteBusyIds = reactive(new Set<string>());
const providerForm = reactive<ProviderForm>({
  id: "",
  expectedVersion: 0,
  name: "",
  apiKind: "chat-completions",
  baseUrl: "",
  model: "",
  secret: "",
  parameters: "{}",
  requestTimeoutMs: 30000,
  enabled: true,
});
const routeForm = reactive({
  id: "",
  expectedVersion: 0,
  name: "",
  providerIds: [] as string[],
  fallbackEnabled: true,
  maxRounds: 2,
  initialDelayMs: 500,
  failureThreshold: 3,
  cooldownMs: 60000,
  enabled: true,
});
const providerNames = computed(
  () => new Map(providers.value.map((item) => [item.id, item.name])),
);
const healthLabels: Record<string, string> = {
  healthy: "健康",
  degraded: "已降级",
  "half-open": "恢复探测",
};

function healthLabel(state: string) {
  return healthLabels[state] ?? state;
}

function routeToggleLabel(item: AiRoute) {
  if (routeToggleBusyIds.has(item.id)) {
    return item.enabled ? "停用中…" : "启用中…";
  }
  return item.enabled ? "已启用" : "已停用";
}

function moveRouteProvider(providerId: string, offset: -1 | 1) {
  const currentIndex = routeForm.providerIds.indexOf(providerId);
  const nextIndex = currentIndex + offset;
  if (
    currentIndex < 0 ||
    nextIndex < 0 ||
    nextIndex >= routeForm.providerIds.length
  ) {
    return;
  }
  const ordered = [...routeForm.providerIds];
  [ordered[currentIndex], ordered[nextIndex]] = [
    ordered[nextIndex],
    ordered[currentIndex],
  ];
  routeForm.providerIds = ordered;
}

async function load() {
  busy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    [providers.value, routes.value] = await Promise.all([
      apiRequest<Provider[]>("/api/v1/ai/providers"),
      apiRequest<AiRoute[]>("/api/v1/ai/routes"),
    ]);
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    busy.value = false;
  }
}
function resetProvider() {
  Object.assign(providerForm, {
    id: "",
    expectedVersion: 0,
    name: "",
    apiKind: "chat-completions",
    baseUrl: "",
    model: "",
    secret: "",
    parameters: "{}",
    requestTimeoutMs: 30000,
    enabled: true,
  });
}
function editProvider(item: Provider) {
  Object.assign(providerForm, {
    id: item.id,
    expectedVersion: item.version,
    name: item.name,
    apiKind: item.apiKind,
    baseUrl: item.baseUrl,
    model: item.model,
    secret: "",
    parameters: JSON.stringify(item.parameters, null, 2),
    requestTimeoutMs: item.requestTimeoutMs,
    enabled: item.enabled,
  });
  document
    .querySelector("#provider-form")
    ?.scrollIntoView({ behavior: "smooth" });
}
async function saveProvider() {
  if (providerFormBusy.value) return;
  const isUpdate = providerForm.id !== "";
  providerFormBusy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    const payload = {
      name: providerForm.name,
      apiKind: providerForm.apiKind,
      baseUrl: providerForm.baseUrl,
      model: providerForm.model,
      ...(providerForm.secret ? { secret: providerForm.secret } : {}),
      parameters: parseJsonObject(providerForm.parameters),
      requestTimeoutMs: providerForm.requestTimeoutMs,
      enabled: providerForm.enabled,
      ...(providerForm.id
        ? { expectedVersion: providerForm.expectedVersion }
        : {}),
    };
    const saved = await apiRequest<Provider>(
      providerForm.id
        ? `/api/v1/ai/providers/${providerForm.id}`
        : "/api/v1/ai/providers",
      { method: providerForm.id ? "PUT" : "POST", body: jsonBody(payload) },
    );
    providers.value = [
      ...providers.value.filter((item) => item.id !== saved.id),
      saved,
    ].sort((left, right) => left.sortOrder - right.sortOrder);
    resetProvider();
    message.value = `已${isUpdate ? "更新" : "创建"} AI Provider「${saved.name}」。`;
    messageIsError.value = false;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    providerFormBusy.value = false;
  }
}
async function providerAction(
  item: Provider,
  action: "toggle" | "test" | "reset" | "delete",
) {
  if (action === "toggle" && providerToggleBusyIds.has(item.id)) return;
  if (action === "test" && providerTestBusyIds.has(item.id)) return;
  if (action === "reset" && providerResetBusyIds.has(item.id)) return;
  if (action === "delete" && providerDeleteBusyIds.has(item.id)) return;
  if (
    action === "delete" &&
    !window.confirm(`确认删除 AI Provider「${item.name}」？`)
  )
    return;
  if (action === "toggle") {
    message.value = "";
    messageIsError.value = false;
    providerToggleBusyIds.add(item.id);
  }
  if (action === "test") {
    message.value = "";
    messageIsError.value = false;
    providerTestBusyIds.add(item.id);
  }
  if (action === "reset") {
    message.value = "";
    messageIsError.value = false;
    providerResetBusyIds.add(item.id);
  }
  if (action === "delete") {
    message.value = "";
    messageIsError.value = false;
    providerDeleteBusyIds.add(item.id);
  }
  try {
    let feedback: string | null = null;
    let feedbackIsError = false;
    if (action === "toggle") {
      const updated = await apiRequest<Provider>(
        `/api/v1/ai/providers/${item.id}/enabled`,
        {
          method: "PATCH",
          body: jsonBody({
            enabled: !item.enabled,
            expectedVersion: item.version,
          }),
        },
      );
      providers.value = providers.value.map((provider) =>
        provider.id === updated.id ? updated : provider,
      );
      feedback = `已${updated.enabled ? "启用" : "停用"} AI Provider「${updated.name}」。`;
    }
    if (action === "test") {
      const result = await apiRequest<{
        success: boolean;
        model: string;
        message: string;
        durationMs: number;
        errorCode: string | null;
      }>(`/api/v1/ai/providers/${item.id}/test`, { method: "POST" });
      feedback = result.success
        ? `AI Provider「${item.name}」连接测试成功（${result.model} · ${result.durationMs} ms）。`
        : `AI Provider「${item.name}」连接测试失败：${result.message}${
            result.errorCode === null ? "" : `（${result.errorCode}）`
          }（${result.durationMs} ms）。`;
      feedbackIsError = !result.success;
    }
    if (action === "reset") {
      const updated = await apiRequest<Provider>(
        `/api/v1/ai/providers/${item.id}/health/reset`,
        { method: "POST" },
      );
      providers.value = providers.value.map((provider) =>
        provider.id === updated.id ? updated : provider,
      );
      feedback = `已重置 AI Provider「${updated.name}」健康状态，当前状态：${healthLabel(updated.health.state)}。`;
    }
    if (action === "delete") {
      const deleted = await apiRequest<Provider>(
        `/api/v1/ai/providers/${item.id}?expectedVersion=${item.version}`,
        { method: "DELETE" },
      );
      providers.value = providers.value.filter(
        (provider) => provider.id !== deleted.id,
      );
      if (providerForm.id === deleted.id) resetProvider();
      feedback = `已删除 AI Provider「${deleted.name}」。`;
    }
    if (feedback !== null) {
      message.value = feedback;
      messageIsError.value = feedbackIsError;
    }
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    if (action === "toggle") providerToggleBusyIds.delete(item.id);
    if (action === "test") providerTestBusyIds.delete(item.id);
    if (action === "reset") providerResetBusyIds.delete(item.id);
    if (action === "delete") providerDeleteBusyIds.delete(item.id);
  }
}
async function dropProvider(targetId: string) {
  if (
    providerOrderBusy.value ||
    draggedId.value === null ||
    draggedId.value === targetId
  )
    return;
  const sourceId = draggedId.value;
  draggedId.value = null;
  const ordered = [...providers.value];
  const source = ordered.findIndex((item) => item.id === sourceId);
  const target = ordered.findIndex((item) => item.id === targetId);
  if (source < 0 || target < 0) return;
  const [moved] = ordered.splice(source, 1);
  if (moved) ordered.splice(target, 0, moved);
  await saveProviderOrder(ordered);
}

async function moveProvider(providerId: string, offset: -1 | 1) {
  if (providerOrderBusy.value) return;
  const ordered = [...providers.value];
  const source = ordered.findIndex((item) => item.id === providerId);
  const target = source + offset;
  if (source < 0 || target < 0 || target >= ordered.length) return;
  const [moved] = ordered.splice(source, 1);
  if (moved) ordered.splice(target, 0, moved);
  await saveProviderOrder(ordered);
}

async function saveProviderOrder(ordered: Provider[]) {
  if (providerOrderBusy.value) return;
  providerOrderBusy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    providers.value = await apiRequest<Provider[]>(
      "/api/v1/ai/providers/reorder",
      {
        method: "PUT",
        body: jsonBody({
          providers: ordered.map((item) => ({
            id: item.id,
            expectedVersion: item.version,
          })),
        }),
      },
    );
    message.value = "已保存 Provider 固定顺序。";
    messageIsError.value = false;
  } catch (cause) {
    const failure = errorMessage(cause);
    await load();
    message.value = failure;
    messageIsError.value = true;
  } finally {
    providerOrderBusy.value = false;
  }
}
function resetRoute() {
  Object.assign(routeForm, {
    id: "",
    expectedVersion: 0,
    name: "",
    providerIds: [],
    fallbackEnabled: true,
    maxRounds: 2,
    initialDelayMs: 500,
    failureThreshold: 3,
    cooldownMs: 60000,
    enabled: true,
  });
}
function editRoute(item: AiRoute) {
  Object.assign(routeForm, {
    id: item.id,
    expectedVersion: item.version,
    name: item.name,
    providerIds: [...item.providerIds],
    fallbackEnabled: item.fallbackEnabled,
    maxRounds: item.retryPolicy.maxRounds,
    initialDelayMs: item.retryPolicy.initialDelayMs,
    failureThreshold: item.degradePolicy.failureThreshold,
    cooldownMs: item.degradePolicy.cooldownMs,
    enabled: item.enabled,
  });
}
async function saveRoute() {
  if (routeFormBusy.value) return;
  const isUpdate = routeForm.id !== "";
  routeFormBusy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    const payload = {
      name: routeForm.name,
      providerIds: routeForm.providerIds,
      fallbackEnabled: routeForm.fallbackEnabled,
      retryPolicy: {
        maxRounds: routeForm.maxRounds,
        initialDelayMs: routeForm.initialDelayMs,
      },
      degradePolicy: {
        failureThreshold: routeForm.failureThreshold,
        cooldownMs: routeForm.cooldownMs,
      },
      enabled: routeForm.enabled,
      ...(routeForm.id ? { expectedVersion: routeForm.expectedVersion } : {}),
    };
    const saved = await apiRequest<AiRoute>(
      routeForm.id ? `/api/v1/ai/routes/${routeForm.id}` : "/api/v1/ai/routes",
      { method: routeForm.id ? "PUT" : "POST", body: jsonBody(payload) },
    );
    routes.value = [
      ...routes.value.filter((item) => item.id !== saved.id),
      saved,
    ];
    resetRoute();
    message.value = `已${isUpdate ? "更新" : "创建"} Provider 路由「${saved.name}」。`;
    messageIsError.value = false;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    routeFormBusy.value = false;
  }
}
async function toggleRoute(item: AiRoute) {
  if (routeToggleBusyIds.has(item.id)) return;
  routeToggleBusyIds.add(item.id);
  message.value = "";
  messageIsError.value = false;
  try {
    const updated = await apiRequest<AiRoute>(
      `/api/v1/ai/routes/${item.id}/enabled`,
      {
        method: "PATCH",
        body: jsonBody({
          enabled: !item.enabled,
          expectedVersion: item.version,
        }),
      },
    );
    routes.value = routes.value.map((route) =>
      route.id === updated.id ? updated : route,
    );
    message.value = `已${updated.enabled ? "启用" : "停用"} Provider 路由「${updated.name}」。`;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    routeToggleBusyIds.delete(item.id);
  }
}
async function deleteRoute(item: AiRoute) {
  if (
    routeDeleteBusyIds.has(item.id) ||
    !window.confirm(`确认删除 Provider 路由「${item.name}」？`)
  )
    return;
  routeDeleteBusyIds.add(item.id);
  message.value = "";
  messageIsError.value = false;
  try {
    const deleted = await apiRequest<AiRoute>(
      `/api/v1/ai/routes/${item.id}?expectedVersion=${item.version}`,
      { method: "DELETE" },
    );
    routes.value = routes.value.filter((route) => route.id !== deleted.id);
    if (routeForm.id === deleted.id) resetRoute();
    message.value = `已删除 Provider 路由「${deleted.name}」。`;
    messageIsError.value = false;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    routeDeleteBusyIds.delete(item.id);
  }
}
onMounted(load);
</script>

<template>
  <main class="page-container split-admin-page reveal">
    <aside class="admin-sidebar">
      <div>
        <p class="eyebrow">AI ROUTING</p>
        <h2>Provider 管理</h2>
      </div>
      <nav>
        <button
          class="active"
          type="button"
          @click="scrollToSection('providers')"
        >
          <Bot :size="18" />Provider
        </button>
        <button type="button" @click="scrollToSection('routes')">
          <Route :size="18" />路由策略
        </button>
      </nav>
      <div class="sidebar-note">
        固定顺序由管理员配置；自动降级只影响当前有效顺序，不会改写人工排序。
      </div>
    </aside>
    <div class="admin-workspace">
      <p v-if="message" class="form-message" :class="{ error: messageIsError }">
        {{ message }}
      </p>
      <section id="providers" class="admin-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">PROVIDERS</p>
            <h1>AI Provider</h1>
          </div>
          <button class="button secondary" :disabled="busy" @click="load">
            <RefreshCw :size="16" />刷新
          </button>
        </div>
        <p class="panel-description">
          拖拽或使用上下按钮改变固定顺序，启停和连通性测试即时反馈；Secret API
          Key 会在服务端加密保存，列表和接口不会回显原值。
        </p>
        <div class="provider-list">
          <article
            v-for="item in providers"
            :key="item.id"
            :draggable="!providerOrderBusy"
            @dragstart="draggedId = item.id"
            @dragover.prevent
            @drop="dropProvider(item.id)"
          >
            <div class="provider-order-controls">
              <GripVertical class="drag-handle" :size="20" aria-hidden="true" />
              <button
                class="icon-button"
                type="button"
                :disabled="providerOrderBusy || providers[0]?.id === item.id"
                :aria-label="`上移 ${item.name}`"
                :title="`上移 ${item.name}`"
                @click="moveProvider(item.id, -1)"
              >
                <ChevronUp :size="14" />
              </button>
              <button
                class="icon-button"
                type="button"
                :disabled="
                  providerOrderBusy ||
                  providers[providers.length - 1]?.id === item.id
                "
                :aria-label="`下移 ${item.name}`"
                :title="`下移 ${item.name}`"
                @click="moveProvider(item.id, 1)"
              >
                <ChevronDown :size="14" />
              </button>
            </div>
            <div class="provider-main">
              <header>
                <strong>{{ item.name }}</strong
                ><span class="table-status" :class="item.health.state">{{
                  healthLabel(item.health.state)
                }}</span
                ><span v-if="!item.enabled" class="table-status danger"
                  >已停用</span
                >
              </header>
              <p>{{ item.baseUrl }} · {{ item.apiKind }}</p>
              <footer>
                <span>{{ item.model }}</span
                ><span>{{ item.requestTimeoutMs / 1000 }}s</span
                ><span>{{
                  item.secretConfigured ? "API Key 已配置" : "API Key 未配置"
                }}</span
                ><span v-if="item.health.lastErrorCode">{{
                  item.health.lastErrorCode
                }}</span>
              </footer>
            </div>
            <div class="row-actions">
              <button
                class="button tiny secondary provider-test-action"
                :disabled="providerTestBusyIds.has(item.id)"
                :aria-busy="providerTestBusyIds.has(item.id)"
                @click="providerAction(item, 'test')"
              >
                <TestTube2 :size="14" />{{
                  providerTestBusyIds.has(item.id) ? "测试中…" : "测试"
                }}</button
              ><button
                class="button tiny secondary"
                @click="editProvider(item)"
              >
                编辑</button
              ><button
                class="button tiny secondary provider-reset-action"
                :disabled="providerResetBusyIds.has(item.id)"
                :aria-busy="providerResetBusyIds.has(item.id)"
                @click="providerAction(item, 'reset')"
              >
                <Activity :size="14" />{{
                  providerResetBusyIds.has(item.id) ? "重置中…" : "重置"
                }}</button
              ><button
                class="button tiny"
                :class="item.enabled ? 'danger-ghost' : 'secondary'"
                :disabled="providerToggleBusyIds.has(item.id)"
                :aria-busy="providerToggleBusyIds.has(item.id)"
                @click="providerAction(item, 'toggle')"
              >
                {{
                  providerToggleBusyIds.has(item.id)
                    ? item.enabled
                      ? "停用中…"
                      : "启用中…"
                    : item.enabled
                      ? "停用"
                      : "启用"
                }}</button
              ><button
                class="icon-button danger"
                :disabled="providerDeleteBusyIds.has(item.id)"
                :aria-busy="providerDeleteBusyIds.has(item.id)"
                :aria-label="
                  providerDeleteBusyIds.has(item.id)
                    ? `正在删除 ${item.name}`
                    : `删除 ${item.name}`
                "
                :title="
                  providerDeleteBusyIds.has(item.id)
                    ? `正在删除 ${item.name}`
                    : `删除 ${item.name}`
                "
                @click="providerAction(item, 'delete')"
              >
                <RefreshCw
                  v-if="providerDeleteBusyIds.has(item.id)"
                  class="button-spinner"
                  :size="15"
                />
                <Trash2 v-else :size="15" />
              </button>
            </div>
          </article>
          <div v-if="!providers.length" class="empty-panel">
            <Bot :size="28" /><strong>暂无 Provider</strong>
          </div>
        </div>
        <form
          id="provider-form"
          class="settings-form boxed-form"
          @submit.prevent="saveProvider"
        >
          <h3>
            <Plus :size="18" />{{
              providerForm.id ? "编辑 Provider" : "新建 Provider"
            }}
          </h3>
          <div class="field-grid">
            <label
              ><span>名称</span
              ><input v-model.trim="providerForm.name" required /></label
            ><label
              ><span>API 类型</span
              ><select v-model="providerForm.apiKind">
                <option value="chat-completions">Chat Completions</option>
                <option value="responses">Responses</option>
              </select></label
            ><label class="wide-field"
              ><span>Base URL</span
              ><input
                v-model.trim="providerForm.baseUrl"
                type="url"
                required /></label
            ><label
              ><span>模型</span
              ><input v-model.trim="providerForm.model" required /></label
            ><label
              ><span>API Key / Secret</span
              ><input
                v-model="providerForm.secret"
                type="password"
                autocomplete="new-password"
                placeholder="例如 sk-…；留空则保留当前值" /></label
            ><label
              ><span>超时（毫秒）</span
              ><input
                v-model.number="providerForm.requestTimeoutMs"
                type="number"
                min="1000"
                max="120000"
                required /></label
            ><label class="wide-field"
              ><span>默认参数（JSON）</span
              ><textarea v-model="providerForm.parameters" rows="4"></textarea>
            </label>
          </div>
          <div class="form-actions">
            <button
              v-if="providerForm.id"
              class="button secondary"
              type="button"
              @click="resetProvider"
            >
              取消</button
            ><button
              class="button primary"
              :disabled="providerFormBusy"
              :aria-busy="providerFormBusy"
            >
              <Save :size="16" />{{
                providerFormBusy ? "保存中…" : "保存 Provider"
              }}
            </button>
          </div>
        </form>
      </section>
      <section id="routes" class="admin-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">RETRY · FALLBACK · DEGRADE</p>
            <h2>Provider 路由</h2>
          </div>
          <span class="state-badge">版本化策略</span>
        </div>
        <div class="route-grid">
          <article v-for="item in routes" :key="item.id">
            <header>
              <div>
                <strong>{{ item.name }}</strong
                ><span>v{{ item.version }}</span>
              </div>
              <button
                class="switch-button"
                :class="{ active: item.enabled }"
                :disabled="routeToggleBusyIds.has(item.id)"
                :aria-busy="routeToggleBusyIds.has(item.id)"
                @click="toggleRoute(item)"
              >
                <span></span>{{ routeToggleLabel(item) }}
              </button>
            </header>
            <div class="route-order-block">
              <span class="route-order-label">固定候选</span>
              <div class="route-flow">
                <span
                  v-for="(id, index) in item.configuredProviderIds.length
                    ? item.configuredProviderIds
                    : providers.map((provider) => provider.id)"
                  :key="id"
                  :class="{
                    unavailable: item.unavailableProviderIds.includes(id),
                  }"
                  >{{ index + 1 }} ·
                  {{ providerNames.get(id) || id.slice(0, 8) }}</span
                >
              </div>
            </div>
            <div class="route-order-block">
              <span class="route-order-label">当前有效</span>
              <div class="route-flow effective">
                <span v-for="(id, index) in item.effectiveProviderIds" :key="id"
                  >{{ index + 1 }} ·
                  {{ providerNames.get(id) || id.slice(0, 8) }}</span
                ><span v-if="!item.effectiveProviderIds.length" class="empty"
                  >暂无可用候选</span
                >
              </div>
            </div>
            <p>
              Fallback {{ item.fallbackEnabled ? "开启" : "关闭" }} ·
              {{ item.retryPolicy.maxRounds }} 轮 ·
              {{ item.degradePolicy.failureThreshold }} 次失败后冷却
              {{ item.degradePolicy.cooldownMs / 1000 }}s
            </p>
            <div class="row-actions">
              <button class="button tiny secondary" @click="editRoute(item)">
                编辑策略</button
              ><button
                class="icon-button danger"
                :disabled="routeDeleteBusyIds.has(item.id)"
                :aria-busy="routeDeleteBusyIds.has(item.id)"
                :aria-label="
                  routeDeleteBusyIds.has(item.id)
                    ? `正在删除 ${item.name}`
                    : `删除 ${item.name}`
                "
                @click="deleteRoute(item)"
              >
                <RefreshCw
                  v-if="routeDeleteBusyIds.has(item.id)"
                  class="button-spinner"
                  :size="15"
                /><Trash2 v-else :size="15" />
              </button>
            </div>
          </article>
        </div>
        <form class="settings-form boxed-form" @submit.prevent="saveRoute">
          <h3>
            <Route :size="18" />{{ routeForm.id ? "编辑路由" : "新建路由" }}
          </h3>
          <div class="field-grid">
            <label
              ><span>名称</span
              ><input v-model.trim="routeForm.name" required /></label
            ><label
              ><span>最大轮次</span
              ><input
                v-model.number="routeForm.maxRounds"
                type="number"
                min="1"
                max="5" /></label
            ><label
              ><span>初始延迟（ms）</span
              ><input
                v-model.number="routeForm.initialDelayMs"
                type="number"
                min="0"
                max="10000" /></label
            ><label
              ><span>降级阈值</span
              ><input
                v-model.number="routeForm.failureThreshold"
                type="number"
                min="1"
                max="100" /></label
            ><label
              ><span>冷却时间（ms）</span
              ><input
                v-model.number="routeForm.cooldownMs"
                type="number"
                min="1000"
                max="3600000" /></label
            ><label class="checkbox-field"
              ><input
                v-model="routeForm.fallbackEnabled"
                type="checkbox"
              /><span>启用 Fallback</span></label
            >
            <fieldset class="wide-field">
              <legend>有序候选</legend>
              <div class="candidate-options">
                <label
                  v-for="item in providers"
                  :key="item.id"
                  class="checkbox-field"
                  ><input
                    v-model="routeForm.providerIds"
                    type="checkbox"
                    :value="item.id"
                  /><span>{{ item.name }}</span></label
                >
              </div>
              <div
                v-if="routeForm.providerIds.length"
                class="selected-provider-order"
              >
                <div v-for="(id, index) in routeForm.providerIds" :key="id">
                  <span
                    >{{ index + 1 }} · {{ providerNames.get(id) || id }}</span
                  >
                  <div>
                    <button
                      type="button"
                      :disabled="index === 0"
                      :aria-label="`上移 ${providerNames.get(id) || id}`"
                      @click="moveRouteProvider(id, -1)"
                    >
                      ↑</button
                    ><button
                      type="button"
                      :disabled="index === routeForm.providerIds.length - 1"
                      :aria-label="`下移 ${providerNames.get(id) || id}`"
                      @click="moveRouteProvider(id, 1)"
                    >
                      ↓
                    </button>
                  </div>
                </div>
              </div>
            </fieldset>
          </div>
          <div class="form-actions">
            <button
              v-if="routeForm.id"
              class="button secondary"
              type="button"
              @click="resetRoute"
            >
              取消</button
            ><button
              class="button primary"
              :disabled="routeFormBusy"
              :aria-busy="routeFormBusy"
            >
              <Save :size="16" />{{ routeFormBusy ? "保存中…" : "保存路由" }}
            </button>
          </div>
        </form>
      </section>
    </div>
  </main>
</template>
