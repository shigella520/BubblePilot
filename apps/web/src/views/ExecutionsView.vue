<script setup lang="ts">
import {
  FileClock,
  RefreshCw,
  RotateCcw,
  Route,
  Search,
  ShieldCheck,
  XCircle,
} from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";

import SensitiveUnlock from "../components/SensitiveUnlock.vue";
import { apiRequest, errorMessage } from "../services/api";
import { useSessionStore } from "../stores/session";

interface Execution {
  id: string;
  workflowName: string;
  workflowVersion: number;
  triggerName: string;
  status: string;
  retryOfExecutionId: string | null;
  recoveryAttempt: number;
  currentNodeId: string | null;
  errorCode: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  completedAt: string | null;
}
interface ExecutionDetail extends Execution {
  correlationId: string;
  nodes: Array<{
    id: string;
    nodeId: string;
    nodeType: string;
    attempt: number;
    status: string;
    durationMs: number | null;
    errorCode: string | null;
    inputSummary: unknown;
    outputSummary: unknown;
  }>;
  deliveries: Array<{
    id: string;
    nodeId: string;
    status: string;
    attemptCount: number;
    errorCode: string | null;
  }>;
  aiProviderAttempts: Array<{
    id: string;
    routeId: string;
    routeVersion: number;
    providerId: string;
    providerName: string;
    providerVersion: number;
    model: string;
    round: number;
    sequence: number;
    status: string;
    selectionHealthState: string;
    healthState: string;
    durationMs: number;
    errorCategory: string | null;
    errorCode: string | null;
    retryable: boolean | null;
    fallbackAllowed: boolean | null;
  }>;
}
interface AuditEvent {
  id: string;
  actorType: string;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: string;
  correlationId: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

const executions = ref<Execution[]>([]);
const audits = ref<AuditEvent[]>([]);
const detail = ref<ExecutionDetail | null>(null);
const message = ref("");
const messageIsError = ref(false);
const busy = ref(false);
const recoveryBusy = ref(false);
const recoveryOnly = ref(false);
const detailLoadingId = ref<string | null>(null);
let inspectRequestId = 0;
const route = useRoute();
const session = useSessionStore();
const providerHealthLabels: Record<string, string> = {
  healthy: "健康",
  degraded: "已降级",
  "half-open": "恢复探测",
};
const canOperate = computed(
  () =>
    detail.value !== null &&
    ["retrying", "failed", "dead-lettered"].includes(detail.value.status),
);
const retryBlocked = computed(() => {
  if (detail.value === null) return true;
  return detail.value.deliveries.some((delivery) =>
    ["sending", "unknown", "confirmed"].includes(delivery.status),
  );
});
const retryTitle = computed(() => {
  if (retryBlocked.value) return "发送结果未知或已确认，禁止盲目重发";
  if (detail.value?.status === "retrying") {
    return "计划重试仍可能运行；仅在服务端判定逾期后才能创建恢复执行";
  }
  return "创建关联原执行的新恢复执行";
});

function providerHealthLabel(state: string) {
  return providerHealthLabels[state] ?? state;
}

async function load(): Promise<boolean> {
  busy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    [executions.value, audits.value] = await Promise.all([
      apiRequest<Execution[]>(
        recoveryOnly.value
          ? "/api/v1/executions?limit=100&status=retrying,failed,dead-lettered,closed"
          : "/api/v1/executions?limit=100",
      ),
      apiRequest<AuditEvent[]>("/api/v1/audit-events?limit=100"),
    ]);
    return true;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
    return false;
  } finally {
    busy.value = false;
  }
}
async function inspect(id: string) {
  const requestId = ++inspectRequestId;
  detailLoadingId.value = id;
  message.value = "";
  messageIsError.value = false;
  try {
    const loaded = await apiRequest<ExecutionDetail>(
      `/api/v1/executions/${id}`,
    );
    if (requestId !== inspectRequestId) return;
    detail.value = loaded;
  } catch (cause) {
    if (requestId !== inspectRequestId) return;
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    if (requestId === inspectRequestId) detailLoadingId.value = null;
  }
}
function clearDetail() {
  inspectRequestId += 1;
  detailLoadingId.value = null;
  detail.value = null;
}
async function loadSelected() {
  await load();
  const executionId = route.query.executionId;
  if (typeof executionId === "string") await inspect(executionId);
}
async function recover(action: "retry" | "close") {
  if (detail.value === null || !session.sensitiveActive || recoveryBusy.value)
    return;
  if (
    !window.confirm(
      action === "retry"
        ? "确认创建一条新的恢复执行？原执行历史会保留。"
        : "确认人工关闭这条失败执行？",
    )
  )
    return;
  recoveryBusy.value = true;
  message.value = "";
  messageIsError.value = false;
  try {
    const result = await apiRequest<ExecutionDetail>(
      `/api/v1/executions/${detail.value.id}/${action}`,
      { method: "POST" },
    );
    detail.value = result;
    if (await load()) {
      message.value =
        action === "retry" ? "已创建并执行恢复尝试。" : "执行已人工关闭。";
    }
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    recoveryBusy.value = false;
  }
}
watch(
  () => route.query.executionId,
  (executionId) => {
    if (typeof executionId === "string") void inspect(executionId);
  },
);
onMounted(loadSelected);
</script>

<template>
  <main class="page-container split-admin-page reveal">
    <aside class="admin-sidebar">
      <div>
        <p class="eyebrow">TRACEABILITY</p>
        <h2>执行与审计</h2>
      </div>
      <nav>
        <a class="active" href="#executions"><FileClock :size="18" />执行记录</a
        ><a href="#audit"><ShieldCheck :size="18" />审计事件</a>
      </nav>
      <div class="sidebar-note">
        轨迹只保存输入输出摘要、错误码和哈希，不保存完整 Prompt、AI 输出或
        Secret。
      </div>
    </aside>
    <div class="admin-workspace">
      <SensitiveUnlock />
      <p v-if="message" class="form-message" :class="{ error: messageIsError }">
        {{ message }}
      </p>
      <section id="executions" class="admin-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">EXECUTION TRACE</p>
            <h1>工作流执行</h1>
          </div>
          <div class="row-actions">
            <button
              class="button tiny"
              :class="recoveryOnly ? 'primary' : 'secondary'"
              @click="
                recoveryOnly = !recoveryOnly;
                load();
              "
            >
              恢复队列</button
            ><button class="button secondary" :disabled="busy" @click="load">
              <RefreshCw :size="16" />刷新
            </button>
          </div>
        </div>
        <div class="table-shell">
          <table>
            <thead>
              <tr>
                <th>工作流</th>
                <th>触发器</th>
                <th>状态</th>
                <th>当前节点</th>
                <th>时间</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!executions.length">
                <td colspan="6" class="empty-cell">暂无执行</td>
              </tr>
              <tr v-for="item in executions" :key="item.id">
                <td>
                  <strong>{{ item.workflowName }}</strong
                  ><span class="keyline"
                    >v{{ item.workflowVersion }} · {{ item.id }}</span
                  ><span v-if="item.recoveryAttempt" class="keyline"
                    >恢复 #{{ item.recoveryAttempt }}</span
                  >
                </td>
                <td>{{ item.triggerName }}</td>
                <td>
                  <span class="table-status" :class="item.status">{{
                    item.status
                  }}</span>
                </td>
                <td>{{ item.currentNodeId || "—" }}</td>
                <td>{{ new Date(item.createdAt).toLocaleString() }}</td>
                <td>
                  <button
                    class="button tiny secondary"
                    :disabled="detailLoadingId === item.id"
                    :aria-busy="detailLoadingId === item.id"
                    @click="inspect(item.id)"
                  >
                    <Search :size="14" />{{
                      detailLoadingId === item.id ? "加载中…" : "详情"
                    }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section v-if="detail" class="admin-panel trace-detail">
        <div class="panel-head">
          <div>
            <p class="card-kicker">{{ detail.correlationId }}</p>
            <h2>{{ detail.workflowName }} · v{{ detail.workflowVersion }}</h2>
            <p v-if="detail.retryOfExecutionId" class="keyline">
              恢复自 {{ detail.retryOfExecutionId }} · 第
              {{ detail.recoveryAttempt }} 次
            </p>
          </div>
          <div class="row-actions">
            <button
              v-if="canOperate"
              class="button secondary"
              :disabled="
                !session.sensitiveActive || retryBlocked || recoveryBusy
              "
              :title="recoveryBusy ? '恢复请求处理中' : retryTitle"
              @click="recover('retry')"
            >
              <RotateCcw :size="15" />{{
                recoveryBusy ? "处理中…" : "人工重试"
              }}</button
            ><button
              v-if="canOperate"
              class="button danger-ghost"
              :disabled="!session.sensitiveActive || recoveryBusy"
              @click="recover('close')"
            >
              <XCircle :size="15" />{{
                recoveryBusy ? "处理中…" : "人工关闭"
              }}</button
            ><button class="button secondary" @click="clearDetail">
              收起详情
            </button>
          </div>
        </div>
        <div class="trace-columns">
          <section>
            <h3>节点轨迹</h3>
            <article
              v-for="node in detail.nodes"
              :key="node.id"
              class="trace-item"
            >
              <span class="trace-dot" :class="node.status"></span>
              <div>
                <strong>{{ node.nodeId }} · {{ node.nodeType }}</strong>
                <p>
                  attempt {{ node.attempt }} · {{ node.durationMs ?? "—" }} ms ·
                  {{ node.errorCode || node.status }}
                </p>
                <details>
                  <summary>脱敏摘要</summary>
                  <pre>{{
                    JSON.stringify(
                      { input: node.inputSummary, output: node.outputSummary },
                      null,
                      2,
                    )
                  }}</pre>
                </details>
              </div>
            </article>
          </section>
          <section>
            <h3>AI Provider Attempt</h3>
            <article
              v-for="item in detail.aiProviderAttempts"
              :key="item.id"
              class="trace-item"
            >
              <Route :size="17" />
              <div>
                <strong>{{ item.providerName }} · {{ item.model }}</strong>
                <span class="keyline"
                  >路由 v{{ item.routeVersion }} · Provider v{{
                    item.providerVersion
                  }}</span
                >
                <p>
                  第 {{ item.round }} 轮 / 顺序 {{ item.sequence }} ·
                  {{ item.durationMs }} ms · 选择时
                  {{ providerHealthLabel(item.selectionHealthState) }} → 结果
                  {{ providerHealthLabel(item.healthState) }}
                </p>
                <span v-if="item.errorCode" class="table-status danger">{{
                  [item.errorCategory, item.errorCode]
                    .filter(Boolean)
                    .join(" · ")
                }}</span>
                <span v-if="item.status === 'failed'" class="keyline"
                  >{{ item.retryable ? "可重试" : "不可重试" }} ·
                  {{
                    item.fallbackAllowed ? "允许 Fallback" : "停止 Fallback"
                  }}</span
                >
              </div>
            </article>
            <div
              v-if="!detail.aiProviderAttempts.length"
              class="empty-panel compact"
            >
              本次执行没有 AI 调用。
            </div>
            <h3>出站发送</h3>
            <article
              v-for="item in detail.deliveries"
              :key="item.id"
              class="trace-item"
            >
              <span class="trace-dot" :class="item.status"></span>
              <div>
                <strong>{{ item.nodeId }} · {{ item.status }}</strong>
                <p>
                  {{ item.attemptCount }} 次尝试 ·
                  {{ item.errorCode || "无错误" }}
                </p>
              </div>
            </article>
          </section>
        </div>
      </section>
      <section id="audit" class="admin-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">AUDIT & SEARCH</p>
            <h2>审计事件</h2>
          </div>
          <span class="state-badge">不含正文与 Secret</span>
        </div>
        <div class="table-shell">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>主体</th>
                <th>动作</th>
                <th>目标</th>
                <th>结果</th>
                <th>关联 ID</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!audits.length">
                <td colspan="6" class="empty-cell">暂无审计事件</td>
              </tr>
              <tr v-for="item in audits" :key="item.id">
                <td>{{ new Date(item.occurredAt).toLocaleString() }}</td>
                <td>{{ item.actorType }}</td>
                <td>{{ item.action }}</td>
                <td>
                  {{ item.targetType
                  }}<span class="keyline">{{ item.targetId || "—" }}</span>
                </td>
                <td>
                  <span class="table-status" :class="item.outcome">{{
                    item.outcome
                  }}</span>
                </td>
                <td class="mono">{{ item.correlationId.slice(0, 8) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </main>
</template>
