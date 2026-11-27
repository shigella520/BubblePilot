<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { Cable, Database, RefreshCw, Save, Trash2, Wrench } from "@lucide/vue";
import { confirmAction } from "../services/confirm";
import { apiRequest, errorMessage, jsonBody } from "../services/api";
import { ProgressPoller } from "../services/progress-poller";
import { useSessionStore } from "../stores/session";
import { formatDateTime } from "../utils/format";
import {
  isRepairable,
  memoryHealthPath,
  precisionLimit,
  precisionLimits,
  repairErrorMessage,
  returnedDimensions,
  type EmbeddingPrecision,
  type MemoryHealthView,
} from "../utils/memory-health";
import { enumLabel } from "../utils/status-labels";
import DismissibleMessage from "./DismissibleMessage.vue";
import LockedHint from "./LockedHint.vue";
import StatusBadge from "./StatusBadge.vue";
import ToggleSwitch from "./ToggleSwitch.vue";

/** Global long-term retrieval settings (R9), health overview and models. */
interface Generation {
  id: string;
  model: string;
  dimensions: number;
  precision: EmbeddingPrecision;
  /** active | retired | building (legacy) | purged */
  status: string;
  createdAt: string | null;
  retiredAt: string | null;
}
interface Settings {
  enabled: boolean;
  protocol: "ollama" | "openai-compatible";
  baseUrl: string;
  model: string;
  dimensions: number;
  precision?: EmbeddingPrecision;
  modelVersion: string;
  queryPrefix: string;
  timeoutSeconds: number;
  retentionDays: number;
  version: number;
  secretConfigured: boolean;
  databaseReady: boolean;
  generations: Generation[];
}
const session = useSessionStore();
const busy = ref(false);
const error = ref("");
const notice = ref("");
const settings = ref<Settings | null>(null);
const health = ref<MemoryHealthView | null>(null);
const mismatch = ref<number | null>(null);
const secret = ref("");
type FormState = Pick<
  Settings,
  | "enabled"
  | "protocol"
  | "baseUrl"
  | "model"
  | "dimensions"
  | "modelVersion"
  | "queryPrefix"
  | "timeoutSeconds"
  | "retentionDays"
> & { precision: EmbeddingPrecision };
const form = reactive<FormState>({
  enabled: false,
  protocol: "ollama",
  baseUrl: "",
  model: "",
  dimensions: 1024,
  precision: "float32",
  modelVersion: "",
  queryPrefix: "",
  timeoutSeconds: 15,
  retentionDays: 3,
});
let alive = true;

function apply(value: Settings) {
  settings.value = value;
  Object.assign(form, {
    enabled: value.enabled,
    protocol: value.protocol,
    baseUrl: value.baseUrl,
    model: value.model,
    dimensions: value.dimensions,
    precision: value.precision ?? "float32",
    modelVersion: value.modelVersion,
    queryPrefix: value.queryPrefix,
    timeoutSeconds: value.timeoutSeconds,
    retentionDays: value.retentionDays ?? 3,
  });
  secret.value = "";
  mismatch.value = null;
}
async function load() {
  const [value, view] = await Promise.all([
    apiRequest<Settings>("/api/v1/ai/memory/settings"),
    apiRequest<MemoryHealthView>(memoryHealthPath).catch(() => null),
  ]);
  if (!alive) return;
  apply(value);
  health.value = view;
}
async function run(action: () => Promise<void>, mapError = errorMessage) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  healthPoller.invalidate();
  try {
    await action();
  } catch (cause) {
    if (alive) error.value = mapError(cause);
  } finally {
    if (alive) busy.value = false;
  }
}
const healthPoller = new ProgressPoller({
  enabled: () =>
    alive &&
    !document.hidden &&
    !busy.value &&
    !!health.value?.chats.some((c) => c.state === "indexing"),
  load: () => apiRequest<MemoryHealthView>(memoryHealthPath),
  apply: (view) => {
    health.value = view;
  },
  failed: () => undefined,
  intervalMs: 30_000,
});

const limit = computed(() => precisionLimit(form.precision));
const dimensionError = computed(() => {
  const value = form.dimensions;
  if (!Number.isInteger(value) || value < 1) return "请输入正整数维度。";
  if (value <= limit.value) return "";
  return form.precision === "float32" && value <= precisionLimits.float16
    ? `单精度最多 ${precisionLimits.float32} 维；请降低维度，或改用半精度（最多 ${precisionLimits.float16} 维）。`
    : `${enumLabel("embeddingPrecision", form.precision)}最多 ${limit.value} 维，请降低维度。`;
});
/** Saved config beyond its index limit (e.g. legacy 3072 维单精度). */
const savedOverLimit = computed(
  () =>
    !!settings.value &&
    settings.value.dimensions >
      precisionLimit(settings.value.precision ?? "float32"),
);
const modelFields = [
  "protocol",
  "baseUrl",
  "model",
  "dimensions",
  "precision",
  "modelVersion",
  "queryPrefix",
] as const;
/** Any of these creates (or restores) another index generation. */
const modelChanged = computed(() => {
  const saved = settings.value;
  if (!saved) return false;
  return modelFields.some((key) => {
    const before = saved[key] ?? (key === "precision" ? "float32" : "");
    const after = form[key];
    return typeof after === "string" && typeof before === "string"
      ? (key === "queryPrefix" ? after : after.trim()) !==
          (key === "queryPrefix" ? before : before.trim())
      : after !== before;
  });
});
const enabledChats = computed(
  () => health.value?.chats.filter((c) => c.enabled) ?? [],
);
const counts = computed(() => {
  const chats = enabledChats.value;
  const count = (...states: string[]) =>
    chats.filter((c) => states.includes(c.state)).length;
  return {
    healthy: count("healthy"),
    indexing: count("indexing"),
    missing: count("missing"),
    error: count("service-error", "rebuild-required"),
    repairable: chats.filter((c) => isRepairable(c)).length,
  };
});
const retiredGenerations = computed(
  () =>
    settings.value?.generations.filter((g) =>
      ["retired", "building"].includes(g.status),
    ) ?? [],
);
function purgeDate(generation: Generation) {
  const days = settings.value?.retentionDays ?? 3;
  const from = generation.retiredAt ?? generation.createdAt;
  return from ? formatDateTime(Date.parse(from) + days * 86_400_000) : "—";
}

function payload() {
  return {
    enabled: form.enabled,
    protocol: form.protocol,
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    dimensions: form.dimensions,
    precision: form.precision,
    modelVersion: form.modelVersion.trim(),
    queryPrefix: form.queryPrefix,
    ...(Number.isInteger(form.timeoutSeconds)
      ? { timeoutSeconds: form.timeoutSeconds }
      : {}),
    ...(Number.isInteger(form.retentionDays)
      ? { retentionDays: form.retentionDays }
      : {}),
    expectedVersion: settings.value?.version ?? 0,
    ...(secret.value ? { secret: secret.value } : {}),
  };
}
async function probe() {
  if (!session.sensitiveActive) return session.requestUnlock();
  if (dimensionError.value) throw new Error(dimensionError.value);
  mismatch.value = null;
  try {
    const value = await apiRequest<{
      identity: string;
      dimensions: number;
      databaseReady: boolean;
    }>("/api/v1/ai/memory/probe", {
      method: "POST",
      body: jsonBody(payload()),
    });
    notice.value = `连接正常，模型按要求返回 ${value.dimensions} 维向量。${
      value.databaseReady ? "" : "数据库尚未安装 pgvector，暂不能启用。"
    }`;
  } catch (cause) {
    mismatch.value = returnedDimensions(cause);
    throw cause;
  }
}
function useReturnedDimensions() {
  if (!mismatch.value) return;
  form.dimensions = mismatch.value;
  if (mismatch.value > precisionLimits.float32) form.precision = "float16";
  mismatch.value = null;
}
async function save() {
  if (!session.sensitiveActive) return session.requestUnlock();
  if (dimensionError.value) throw new Error(dimensionError.value);
  if (
    modelChanged.value &&
    !(await confirmAction(
      `切换模型后立即生效，已启用的 ${enabledChats.value.length} 个聊天将从零重新建立索引，期间检索结果会逐步恢复；旧模型数据保留 ${form.retentionDays} 天后自动清理，期间改回旧模型可直接恢复。`,
      {
        title: "切换向量模型？",
        confirmText: "切换并重新建立索引",
        danger: false,
      },
    ))
  )
    return;
  const saved = await apiRequest<Settings & { switched: boolean }>(
    "/api/v1/ai/memory/settings",
    { method: "PUT", body: jsonBody(payload()) },
  );
  apply(saved);
  notice.value = saved.switched
    ? `已切换到 ${saved.model}，新模型立即生效；已启用的聊天正在后台重新建立索引，检索结果会逐步恢复。`
    : "配置已保存。";
  health.value = await apiRequest<MemoryHealthView>(memoryHealthPath).catch(
    () => health.value,
  );
}
async function repairAll() {
  if (!session.sensitiveActive) return session.requestUnlock();
  const value = await apiRequest<{
    repaired: { chatId: string; action: string; jobIds: string[] }[];
  }>("/api/v1/memory/repair", { method: "POST" });
  const rebuilds = value.repaired.filter((r) => r.action === "rebuild").length;
  notice.value = value.repaired.length
    ? `已为 ${value.repaired.length} 个聊天开始修复${
        rebuilds ? `（其中 ${rebuilds} 个启动归属重建）` : ""
      }，进度见下方「索引任务」。`
    : "没有需要修复的聊天。";
  health.value = await apiRequest<MemoryHealthView>(memoryHealthPath);
}
async function purge() {
  if (!session.sensitiveActive) return session.requestUnlock();
  if (
    !(await confirmAction(
      "将立即删除已停用模型的全部向量和分块，删除后无法恢复，切回这些模型需要重新建立索引。",
      {
        title: "清理历史向量数据？",
        confirmText: "立即删除",
        danger: true,
      },
    ))
  )
    return;
  const value = await apiRequest<{ generations: number; chunks: number }>(
    "/api/v1/ai/memory/purge",
    { method: "POST" },
  );
  notice.value = `已清理 ${value.generations} 个旧模型的向量数据（${value.chunks} 个分块）。`;
  await load();
}
function generationStatus(generation: Generation) {
  if (generation.status === "retired" && generation.retiredAt)
    return `已停用 · 停用于 ${formatDateTime(generation.retiredAt)}`;
  return undefined;
}

onMounted(() => {
  void run(load);
  healthPoller.start();
});
onBeforeUnmount(() => {
  alive = false;
  healthPoller.stop();
  secret.value = "";
});
</script>

<template>
  <section id="memory-settings" class="admin-panel memory-settings">
    <div class="panel-head">
      <div>
        <p class="card-kicker">长期检索</p>
        <h2>长期检索设置</h2>
      </div>
      <button
        class="button secondary"
        type="button"
        :disabled="busy"
        @click="run(load)"
      >
        <RefreshCw :size="16" />{{ busy ? "刷新中…" : "刷新" }}
      </button>
    </div>
    <p class="panel-description">
      AI
      根据问题自行检索已启用聊天的历史，无需添加工作流节点；可检索范围受消息保留期限限制。索引文本会发送到下方向量服务，检索出的证据会发送到当前对话
      Provider。
    </p>
    <DismissibleMessage v-if="error" error @close="error = ''">{{
      error
    }}</DismissibleMessage>
    <DismissibleMessage v-else-if="notice" @close="notice = ''">{{
      notice
    }}</DismissibleMessage>

    <dl v-if="settings" class="memory-summary">
      <div>
        <dt>已启用聊天</dt>
        <dd>{{ health ? enabledChats.length : "—" }}</dd>
      </div>
      <div>
        <dt>正常</dt>
        <dd>{{ health ? counts.healthy : "—" }}</dd>
      </div>
      <div>
        <dt>索引中</dt>
        <dd>{{ health ? counts.indexing : "—" }}</dd>
      </div>
      <div>
        <dt>有缺失</dt>
        <dd>{{ health ? counts.missing : "—" }}</dd>
      </div>
      <div>
        <dt>异常 / 需重建</dt>
        <dd>{{ health ? counts.error : "—" }}</dd>
      </div>
    </dl>
    <div v-if="settings" class="form-actions memory-summary-actions">
      <span class="panel-description">
        <Database :size="15" />数据库{{
          settings.databaseReady ? "已准备" : "需要安装 pgvector"
        }}<template v-if="health?.generation">
          · 当前模型 {{ health.generation.model }} ·
          {{ health.generation.dimensions }} 维
          {{ enumLabel("embeddingPrecision", health.generation.precision) }}
        </template>
      </span>
      <button
        class="button secondary"
        type="button"
        :disabled="busy || !counts.repairable"
        :title="
          session.sensitiveActive ? undefined : '需要敏感操作授权，点击解锁'
        "
        @click="run(repairAll, repairErrorMessage)"
      >
        <Wrench :size="16" />修复全部{{
          counts.repairable ? `（${counts.repairable}）` : ""
        }}
      </button>
    </div>

    <p v-if="savedOverLimit && settings" class="memory-warning" role="status">
      当前保存的配置为 {{ settings.dimensions }} 维{{
        enumLabel("embeddingPrecision", settings.precision ?? "float32")
      }}，超过可建索引的上限（单精度 {{ precisionLimits.float32 }} 维、半精度
      {{ precisionLimits.float16 }}
      维），需要降低维度或改用半精度后保存；保存后会切换为新配置并重新建立索引。
    </p>

    <LockedHint
      v-if="settings"
      reason="修改设置、测试连接和修复需要敏感操作授权。"
    />
    <form
      v-if="settings"
      class="settings-form boxed-form"
      @submit.prevent="run(save)"
    >
      <fieldset
        class="memory-settings-fields"
        :disabled="busy || !session.sensitiveActive"
      >
        <div class="memory-toggle">
          <div>
            <strong>启用长期检索</strong>
            <p class="panel-description">
              关闭后所有聊天暂停检索与索引，已建立的索引保留。
            </p>
          </div>
          <ToggleSwitch v-model="form.enabled" label="启用长期检索" />
        </div>
        <div class="field-grid">
          <label
            ><span>服务协议</span
            ><select v-model="form.protocol">
              <option value="ollama">Ollama</option>
              <option value="openai-compatible">
                OpenAI 兼容 Embedding API
              </option>
            </select></label
          >
          <label class="memory-url-field"
            ><span>服务地址</span
            ><input v-model="form.baseUrl" type="url" required
          /></label>
          <label
            ><span>模型</span><input v-model="form.model" required
          /></label>
          <label
            ><span>凭据</span
            ><input
              v-model="secret"
              type="password"
              autocomplete="new-password"
              :placeholder="
                settings.secretConfigured ? '已配置，留空则保留' : '未配置'
              "
          /></label>
          <label
            ><span>请求超时（秒）</span
            ><input
              v-model.number="form.timeoutSeconds"
              type="number"
              min="5"
              max="120"
              step="1"
              required
            /><small>只改超时不会重建索引。</small></label
          >
          <label
            ><span>维度</span
            ><input
              v-model.number="form.dimensions"
              type="number"
              min="1"
              :max="limit"
              step="1"
              required
              :aria-invalid="!!dimensionError"
            /><small
              v-if="dimensionError"
              class="memory-field-error"
              role="alert"
              >{{ dimensionError }}</small
            ><small v-else>模型按此维度输出向量。</small></label
          >
          <label
            ><span>精度</span
            ><select v-model="form.precision">
              <option value="float32">
                单精度 float32（≤ {{ precisionLimits.float32 }} 维）
              </option>
              <option value="float16">
                半精度 float16（≤ {{ precisionLimits.float16 }} 维）
              </option></select
            ><small>半精度占用空间减半，检索效果基本一致。</small></label
          >
        </div>
        <p v-if="mismatch" class="memory-warning" role="status">
          服务返回了 {{ mismatch }} 维向量，与配置的 {{ form.dimensions }}
          维不一致，可能不支持指定维度。
          <button
            v-if="mismatch <= precisionLimits.float16"
            class="button tiny secondary"
            type="button"
            @click="useReturnedDimensions"
          >
            改为 {{ mismatch }} 维
          </button>
        </p>
        <details class="advanced-settings">
          <summary>高级设置</summary>
          <div class="field-grid">
            <label class="wide-field"
              ><span>问题编码前缀</span
              ><textarea v-model="form.queryPrefix" rows="3" />
            </label>
            <label
              ><span>模型版本标识</span
              ><input v-model="form.modelVersion" required /><small
                >同名模型更新权重时修改，会重新建立索引。</small
              ></label
            >
            <label
              ><span>旧模型数据保留天数</span
              ><input
                v-model.number="form.retentionDays"
                type="number"
                min="1"
                max="90"
                step="1"
                required
              /><small
                >切换模型后旧模型的向量保留 1～90 天（默认 3
                天），期间改回可直接恢复。</small
              ></label
            >
          </div>
        </details>
        <p v-if="modelChanged" class="panel-description" role="status">
          模型配置已修改：保存后立即切换，已启用的聊天将重新建立索引。
        </p>
        <div class="form-actions">
          <button
            class="button secondary"
            type="button"
            :disabled="!!dimensionError"
            @click="run(probe)"
          >
            <Cable :size="16" />测试连接
          </button>
          <button
            class="button primary"
            type="submit"
            :disabled="!!dimensionError"
          >
            <Save :size="16" />{{ busy ? "处理中…" : "保存" }}
          </button>
        </div>
      </fieldset>
    </form>

    <div v-if="settings" class="memory-generations">
      <div class="memory-generations-head">
        <h3>模型与向量数据</h3>
        <button
          class="button danger-ghost"
          type="button"
          :disabled="busy || !retiredGenerations.length"
          :title="
            retiredGenerations.length
              ? '立即删除已停用模型的向量数据'
              : '没有已停用模型的数据'
          "
          @click="run(purge)"
        >
          <Trash2 :size="16" />清理历史向量数据
        </button>
      </div>
      <p class="panel-description">
        已停用模型的向量在停用 {{ settings.retentionDays }}
        天后自动清理；清理前改回该模型可直接恢复。
      </p>
      <div class="table-shell">
        <table>
          <thead>
            <tr>
              <th>模型</th>
              <th>维度 / 精度</th>
              <th>状态</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in settings.generations" :key="g.id">
              <td>{{ g.model }}</td>
              <td>
                {{ g.dimensions }} 维 ·
                {{ enumLabel("embeddingPrecision", g.precision) }}
              </td>
              <td>
                <StatusBadge
                  domain="memoryGeneration"
                  :status="g.status"
                  :label="generationStatus(g)"
                />
                <small v-if="['retired', 'building'].includes(g.status)"
                  >预计 {{ purgeDate(g) }} 自动清理</small
                >
              </td>
              <td>{{ formatDateTime(g.createdAt) }}</td>
            </tr>
            <tr v-if="!settings.generations.length">
              <td colspan="4">尚未保存过向量模型。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<style scoped>
.memory-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 130px), 1fr));
  gap: 12px;
  margin: 18px 0 10px;
}
.memory-summary div {
  min-width: 0;
  padding: 14px;
  border-radius: 16px;
  background: var(--bubblepilot-surface, rgba(255, 255, 255, 0.65));
}
.memory-summary dt {
  color: var(--bubblepilot-muted);
  font-size: 13px;
}
.memory-summary dd {
  margin: 6px 0 0;
  font-size: var(--bubblepilot-text-xl);
  font-weight: 700;
}
.memory-summary-actions {
  justify-content: space-between;
}
.memory-warning {
  margin: 12px 0;
  padding: 12px 16px;
  border-radius: 12px;
  background: var(--bubblepilot-warning-bg);
  color: var(--bubblepilot-warning);
}
.memory-settings-fields {
  display: grid;
  gap: 15px;
  margin: 0;
  padding: 0;
  border: 0;
}
.memory-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.memory-toggle .panel-description {
  margin: 4px 0 0;
}
/* Protocol and address share the first row. */
.memory-url-field {
  grid-column: span 2;
}
/* Two- and one-column layouts: the address takes its own full row. */
@media (max-width: 1180px) {
  .memory-url-field {
    grid-column: 1 / -1;
  }
}
.memory-field-error {
  color: var(--bubblepilot-danger);
}
.memory-generations {
  margin-top: 22px;
}
.memory-generations-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.memory-generations-head h3 {
  margin: 0;
}
.memory-generations td small {
  display: block;
  margin-top: 4px;
  color: var(--bubblepilot-muted);
}
</style>
