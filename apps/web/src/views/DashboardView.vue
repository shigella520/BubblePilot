<script setup lang="ts">
import { enumLabel } from "../utils/status-labels";
import { partialFailureMessage, settleAll } from "../utils/settle";
import { formatDateTime } from "../utils/format";
import StatusBadge from "../components/StatusBadge.vue";
import MemeDeliveries from "../components/MemeDeliveries.vue";
import {
  AlertTriangle,
  Bot,
  Boxes,
  CheckCircle2,
  MessagesSquare,
  PlayCircle,
  RefreshCw,
} from "@lucide/vue";
import { onMounted, reactive, ref } from "vue";

import DismissibleMessage from "../components/DismissibleMessage.vue";
import { apiAllPages, apiRequest, errorMessage } from "../services/api";

const counts = reactive<{
  chats: number;
  workflows: number;
  providers: number;
  /** "100+" when the last 24h exceed one page of executions. */
  executions: number | string;
}>({
  chats: 0,
  workflows: 0,
  providers: 0,
  executions: 0,
});
const recent = ref<
  Array<{ id: string; workflowName: string; status: string; createdAt: string }>
>([]);
type AutomationOutcome =
  | "unsupported-event"
  | "chat-not-monitored"
  | "evaluation-pending"
  | "not-evaluated"
  | "no-active-triggers"
  | "no-trigger-match"
  | "matched";
interface InboundEvent {
  id: string;
  eventId: string;
  correlationId: string;
  eventType: string;
  ingestionStatus: "accepted" | "ignored" | "completed" | "failed";
  automationOutcome: AutomationOutcome;
  archiveUpdate?: { status: string; reason: string | null; attempts: number };
  replyWake?: { status: string; decision: string | null } | null;
  receivedAt: string;
}
const inboundEvents = ref<InboundEvent[]>([]);
const operations = ref<{
  status: "healthy" | "attention" | "critical";
  workflow: {
    executions: {
      retrying: number;
      deadLettered: number;
      staleRetrying: number;
    };
    outbound: { unknown: number };
  };
  executionGate: {
    active: number;
    queued: number;
    maxConcurrency: number;
    queueCapacity: number;
  };
  aiProviders: { configured: number; degraded: number };
  messageRetention:
    | { enabled: false; retentionDays: number }
    | {
        enabled: true;
        retentionDays: number;
        running: boolean;
        lastStartedAt: string | null;
        lastCompletedAt: string | null;
        lastSuccessAt: string | null;
        lastErrorAt: string | null;
        lastRedactedCount: number;
        batchLimitReached: boolean;
      };
  alerts: Array<{ code: string; severity: string; count: number }>;
} | null>(null);
const busy = ref(false);
const loaded = ref(false);
const message = ref("");

async function loadRecentExecutions() {
  try {
    // The list API has no time filter: count the last 24h from one page.
    const page = await apiRequest<typeof recent.value>(
      "/api/v1/executions?limit=100",
    );
    recent.value = page.slice(0, 8);
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const day = page.filter(
      (item) => Date.parse(item.createdAt) >= since,
    ).length;
    counts.executions =
      day >= page.length && page.length === 100 ? "100+" : day;
  } catch (cause) {
    message.value = errorMessage(cause);
  }
}

async function load() {
  busy.value = true;
  message.value = "";
  try {
    const { values, failed } = await settleAll({
      chats: () => apiAllPages<{ enabled: boolean }>("/api/v1/chats?limit=100"),
      workflows: () => apiRequest<unknown[]>("/api/v1/workflows"),
      providers: () => apiRequest<unknown[]>("/api/v1/ai/providers"),
      runtime: () =>
        apiRequest<NonNullable<typeof operations.value>>(
          "/api/v1/operations/status",
        ),
      events: () =>
        apiRequest<InboundEvent[]>("/api/v1/inbound-events?limit=8"),
    });
    if (values.chats)
      counts.chats = values.chats.filter((chat) => chat.enabled).length;
    if (values.workflows) counts.workflows = values.workflows.length;
    if (values.providers) counts.providers = values.providers.length;
    if (values.runtime) operations.value = values.runtime;
    if (values.events) inboundEvents.value = values.events;
    message.value = partialFailureMessage(
      failed,
      {
        chats: "聊天统计",
        workflows: "工作流统计",
        providers: "AI Provider 统计",
        runtime: "运行可靠性",
        events: "入站事件",
      },
      errorMessage,
    );
  } catch (cause) {
    message.value = errorMessage(cause);
  } finally {
    busy.value = false;
    loaded.value = true;
  }
  await loadRecentExecutions();
}

const outcomeLabels: Record<AutomationOutcome, string> = {
  "unsupported-event": "不支持的事件",
  "chat-not-monitored": "聊天未监听",
  "evaluation-pending": "等待自动化判定",
  "not-evaluated": "未执行判定",
  "no-active-triggers": "无启用触发器",
  "no-trigger-match": "触发器未命中",
  matched: "已命中并创建执行",
};

function replyWakeLabel(value: NonNullable<InboundEvent["replyWake"]>): string {
  if (value.status === "resolved") {
    if (value.decision === "reply") return "引用 Bot 消息触发";
    if (value.decision === "ordinary") return "原条件已匹配";
    if (!value.decision) return "引用已识别，等待匹配";
    if (value.decision === "not-applicable") return "引用已识别，但未完成匹配";
    return "引用已识别，其他条件未通过";
  }
  const labels: Record<string, string> = {
    unmatched: "引用目标未确认归属",
    ambiguous: "引用目标归属存在冲突",
    unavailable: "引用目标不可判定",
    "from-me": "网关本人消息不走引用入口",
    "no-reference": "未发现引用关系",
    "lookup-error": "引用归属查询失败",
  };
  return labels[value.status] ?? "引用状态未记录";
}

function outcomeClass(outcome: AutomationOutcome): string {
  if (outcome === "matched") return "succeeded";
  if (["evaluation-pending", "not-evaluated"].includes(outcome))
    return "warning";
  return "neutral";
}

onMounted(load);
</script>

<template>
  <main class="page-container admin-workspace reveal">
    <section class="hero-panel compact-hero">
      <div>
        <p class="eyebrow">CONTROL CENTER</p>
        <h1>让每条消息按计划流动。</h1>
        <p>在一个界面中管理监听范围、工作流、AI 路由和可解释执行轨迹。</p>
      </div>
      <button
        class="button secondary"
        type="button"
        :disabled="busy"
        @click="load"
      >
        <RefreshCw :size="17" />刷新状态
      </button>
    </section>
    <DismissibleMessage v-if="message" error @close="message = ''">{{
      message
    }}</DismissibleMessage>
    <section class="metric-grid">
      <RouterLink to="/messages#monitoring" class="metric-card tone-blue"
        ><MessagesSquare :size="23" /><span>监听中的聊天</span
        ><strong>{{ counts.chats }}</strong
        ><em>搜索与监听范围</em></RouterLink
      >
      <RouterLink to="/automation" class="metric-card tone-peach"
        ><Boxes :size="23" /><span>工作流</span
        ><strong>{{ counts.workflows }}</strong
        ><em>版本、触发器与发布</em></RouterLink
      >
      <RouterLink to="/ai#providers" class="metric-card tone-lilac"
        ><Bot :size="23" /><span>AI Provider</span
        ><strong>{{ counts.providers }}</strong
        ><em>Retry、Fallback 与降级</em></RouterLink
      >
      <RouterLink to="/executions#executions" class="metric-card tone-mint"
        ><PlayCircle :size="23" /><span>24 小时执行</span
        ><strong>{{ counts.executions }}</strong
        ><em>节点与发送轨迹</em></RouterLink
      >
    </section>
    <section class="admin-panel">
      <div class="panel-head">
        <div>
          <p class="card-kicker">MESSAGE DECISIONS</p>
          <h2>消息处理判定</h2>
        </div>
        <span class="state-badge">仅安全元数据</span>
      </div>
      <p class="panel-description">
        区分聊天未监听、无启用触发器、条件未命中和已创建执行，不展示消息正文或原始
        Webhook。
      </p>
      <div class="table-shell decision-table-shell">
        <table>
          <thead>
            <tr>
              <th>自动化判定</th>
              <th>接入状态</th>
              <th>事件类型</th>
              <th>接收时间</th>
              <th>事件 / 关联 ID</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!inboundEvents.length">
              <td colspan="5" class="empty-cell">
                {{ loaded ? "暂无入站事件" : "正在加载…" }}
              </td>
            </tr>
            <tr v-for="event in inboundEvents" :key="event.id">
              <td>
                <span
                  class="table-status"
                  :class="outcomeClass(event.automationOutcome)"
                  >{{ outcomeLabels[event.automationOutcome] }}</span
                >
                <small class="muted"
                  ><br />{{
                    event.replyWake
                      ? replyWakeLabel(event.replyWake)
                      : "引用状态未记录"
                  }}</small
                >
              </td>
              <td>
                {{ enumLabel("ingestion", event.ingestionStatus)
                }}<small v-if="event.archiveUpdate" class="muted"
                  ><br />归档修订：{{ event.archiveUpdate.status }}<br />{{
                    event.archiveUpdate.reason
                  }}</small
                >
              </td>
              <td :title="event.eventType">
                {{ enumLabel("eventType", event.eventType) }}
              </td>
              <td>{{ formatDateTime(event.receivedAt) }}</td>
              <td class="mono decision-identifiers">
                <span>{{ event.eventId }}</span>
                <small>{{ event.correlationId }}</small>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section class="admin-panel">
      <div class="panel-head">
        <div>
          <p class="card-kicker">RUNTIME HEALTH</p>
          <h2>运行可靠性</h2>
        </div>
        <StatusBadge
          domain="operations"
          :status="operations?.status ?? (loaded ? 'unknown' : '')"
          :label="!operations && !loaded ? '检查中…' : undefined"
        >
          <CheckCircle2
            v-if="operations?.status === 'healthy'"
            :size="14"
          /><AlertTriangle v-else-if="operations" :size="14" />
        </StatusBadge>
      </div>
      <div v-if="operations" class="runtime-summary-grid">
        <RouterLink
          to="/executions?attention=recovery#executions"
          class="runtime-summary-item"
        >
          <span>死信 / 等待重试</span>
          <strong
            >{{ operations.workflow.executions.deadLettered }} /
            {{ operations.workflow.executions.retrying }}</strong
          >
          <em>卡住 {{ operations.workflow.executions.staleRetrying }}</em>
        </RouterLink>
        <RouterLink
          to="/executions?attention=unknown-outbound#executions"
          class="runtime-summary-item"
        >
          <span>未知出站结果</span>
          <strong>{{ operations.workflow.outbound.unknown }}</strong>
          <em>需要人工确认，不会盲目重发</em>
        </RouterLink>
        <div class="runtime-summary-item">
          <span>执行容量</span>
          <strong
            >{{ operations.executionGate.active }} /
            {{ operations.executionGate.maxConcurrency }}</strong
          >
          <em
            >队列 {{ operations.executionGate.queued }} /
            {{ operations.executionGate.queueCapacity }}</em
          >
        </div>
        <RouterLink to="/ai#providers" class="runtime-summary-item">
          <span>降级 Provider</span>
          <strong>{{ operations.aiProviders.degraded }}</strong>
          <em>共 {{ operations.aiProviders.configured }} 个 Provider</em>
        </RouterLink>
        <div class="runtime-summary-item">
          <span>消息内容保留</span>
          <strong>{{
            operations.messageRetention.enabled
              ? operations.messageRetention.retentionDays + " 天"
              : "已关闭"
          }}</strong>
          <em v-if="operations.messageRetention.enabled">
            最近清理 {{ operations.messageRetention.lastRedactedCount }} 条
          </em>
          <em v-else>保留策略由管理员显式关闭</em>
        </div>
      </div>
      <div v-if="operations?.alerts.length" class="runtime-alert-list">
        <span v-for="alert in operations.alerts" :key="alert.code">
          <span :title="alert.code">{{
            enumLabel("operationsAlert", alert.code)
          }}</span>
          · {{ alert.count }}
        </span>
      </div>
    </section>
    <section class="admin-panel"><MemeDeliveries /></section>
    <section class="admin-panel">
      <div class="panel-head">
        <div>
          <p class="card-kicker">RECENT RUNS</p>
          <h2>最近执行</h2>
        </div>
        <RouterLink class="state-badge" to="/executions#executions"
          >查看全部</RouterLink
        >
      </div>
      <div class="table-shell">
        <table>
          <thead>
            <tr>
              <th>工作流</th>
              <th>状态</th>
              <th>时间</th>
              <th>ID</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!recent.length">
              <td colspan="4" class="empty-cell">
                {{ loaded ? "暂无执行记录" : "正在加载…" }}
              </td>
            </tr>
            <tr v-for="item in recent" :key="item.id">
              <td>{{ item.workflowName }}</td>
              <td>
                <StatusBadge domain="execution" :status="item.status" />
              </td>
              <td>{{ formatDateTime(item.createdAt) }}</td>
              <td class="mono">{{ item.id.slice(0, 8) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</template>
