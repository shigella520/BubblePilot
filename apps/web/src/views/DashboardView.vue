<script setup lang="ts">
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

const counts = reactive({
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
const message = ref("");

async function loadRecentExecutions() {
  try {
    recent.value = await apiRequest<typeof recent.value>(
      "/api/v1/executions?limit=8",
    );
    counts.executions = recent.value.length;
  } catch (cause) {
    message.value = errorMessage(cause);
  }
}

async function load() {
  busy.value = true;
  message.value = "";
  try {
    const [chats, workflows, providers, runtime, events] = await Promise.all([
      apiAllPages<unknown>("/api/v1/chats?limit=100"),
      apiRequest<unknown[]>("/api/v1/workflows"),
      apiRequest<unknown[]>("/api/v1/ai/providers"),
      apiRequest<NonNullable<typeof operations.value>>(
        "/api/v1/operations/status",
      ),
      apiRequest<InboundEvent[]>("/api/v1/inbound-events?limit=8"),
    ]);
    Object.assign(counts, {
      chats: chats.length,
      workflows: workflows.length,
      providers: providers.length,
      executions: counts.executions,
    });
    operations.value = runtime;
    inboundEvents.value = events;
  } catch (cause) {
    message.value = errorMessage(cause);
  } finally {
    busy.value = false;
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
      <RouterLink to="/messages" class="metric-card tone-blue"
        ><MessagesSquare :size="23" /><span>监听中的聊天</span
        ><strong>{{ counts.chats }}</strong
        ><em>搜索与监听范围</em></RouterLink
      >
      <RouterLink to="/automation" class="metric-card tone-peach"
        ><Boxes :size="23" /><span>工作流</span
        ><strong>{{ counts.workflows }}</strong
        ><em>版本、触发器与发布</em></RouterLink
      >
      <RouterLink to="/ai" class="metric-card tone-lilac"
        ><Bot :size="23" /><span>AI Provider</span
        ><strong>{{ counts.providers }}</strong
        ><em>Retry、Fallback 与降级</em></RouterLink
      >
      <RouterLink to="/executions" class="metric-card tone-mint"
        ><PlayCircle :size="23" /><span>最近执行</span
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
              <td colspan="5" class="empty-cell">暂无入站事件</td>
            </tr>
            <tr v-for="event in inboundEvents" :key="event.id">
              <td>
                <span
                  class="table-status"
                  :class="outcomeClass(event.automationOutcome)"
                  >{{ outcomeLabels[event.automationOutcome] }}</span
                >
              </td>
              <td>{{ event.ingestionStatus }}</td>
              <td>{{ event.eventType }}</td>
              <td>{{ new Date(event.receivedAt).toLocaleString() }}</td>
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
        <span
          class="table-status"
          :class="operations?.status === 'healthy' ? 'succeeded' : 'danger'"
        >
          <CheckCircle2
            v-if="operations?.status === 'healthy'"
            :size="14"
          /><AlertTriangle v-else :size="14" />
          {{ operations?.status || "unknown" }}
        </span>
      </div>
      <div v-if="operations" class="runtime-summary-grid">
        <RouterLink to="/executions" class="runtime-summary-item">
          <span>死信 / 等待重试</span>
          <strong
            >{{ operations.workflow.executions.deadLettered }} /
            {{ operations.workflow.executions.retrying }}</strong
          >
          <em>卡住 {{ operations.workflow.executions.staleRetrying }}</em>
        </RouterLink>
        <RouterLink to="/executions" class="runtime-summary-item">
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
        <RouterLink to="/ai" class="runtime-summary-item">
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
          {{ alert.code }} · {{ alert.count }}
        </span>
      </div>
    </section>
    <section class="admin-panel">
      <div class="panel-head">
        <div>
          <p class="card-kicker">RECENT RUNS</p>
          <h2>最近执行</h2>
        </div>
        <RouterLink class="state-badge" to="/executions">查看全部</RouterLink>
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
              <td colspan="4" class="empty-cell">暂无执行记录</td>
            </tr>
            <tr v-for="item in recent" :key="item.id">
              <td>{{ item.workflowName }}</td>
              <td>
                <span class="table-status" :class="item.status">{{
                  item.status
                }}</span>
              </td>
              <td>{{ new Date(item.createdAt).toLocaleString() }}</td>
              <td class="mono">{{ item.id.slice(0, 8) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</template>
