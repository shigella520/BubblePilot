// Fictional preview only: every API request is intercepted, no messages are sent.
import { createApp, h } from "vue";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import ExecutionsView from "../views/ExecutionsView.vue";
import { useSessionStore } from "../stores/session";
import { executionTiming } from "../../../../modules/workflow/execution-timing.js";
import "../styles/tokens.css";
import "../styles/base.css";
const now = new Date();
const stamp = (ms: number) => new Date(now.getTime() - ms).toISOString();
const records = [
  "succeeded",
  "running",
  "failed",
  "retrying",
  "closed",
  "skipped",
].map((status, index) => {
  const record = {
    id: `fictional-execution-${index}`,
    correlationId: `fictional-correlation-${index}`,
    providerChatId: "fictional-chat",
    chatDisplayName: "示例讨论组",
    workflowName:
      index === 2
        ? "用于验证极长标题的示例工作流-".repeat(8)
        : `示例工作流 ${index + 1}`,
    workflowVersion: 3,
    triggerName: "示例触发",
    status,
    retryOfExecutionId: null,
    recoveryAttempt: 0,
    errorCode: status === "failed" ? "FICTIONAL_TIMEOUT" : null,
    currentNodeId: null,
    nextRetryAt: null,
    createdAt: stamp(60000),
    startedAt: index === 5 ? null : stamp(40000),
    completedAt: ["running", "retrying"].includes(status) ? null : stamp(1400),
    cachedPromptTokens: null,
    cacheEligiblePromptTokens: 0,
    cacheHitRate: null,
    contextSnapshot: null,
    startupClosure:
      status === "closed"
        ? {
            reason: "启动时关闭的虚构遗留记录",
            closedAt: stamp(0),
            previousStatus: "running",
          }
        : null,
    nodes:
      index === 5
        ? []
        : Array.from({ length: 20 }, (_, i) => ({
            id: `node-${i}`,
            nodeId: `示例步骤-${i}`,
            nodeType: i === 0 ? "ai-chat" : "log",
            attempt: 1,
            status: "succeeded",
            durationMs: 20,
            errorCode: null,
            inputSummary: {},
            outputSummary: {},
          })),
    deliveries: [],
    aiProviderAttempts: [],
    aiRouteTraces: [],
    aiToolExecutions: [],
    aiImageInputs: [],
  };
  return {
    ...record,
    timing: executionTiming(
      record,
      index === 5
        ? {}
        : {
            model: { durationMs: 26100, count: 3, recordedCount: 3 },
            tools: { durationMs: 9400, count: 2, recordedCount: 2 },
            delivery: { durationMs: 300, count: 1, recordedCount: 1 },
            otherNodes: { durationMs: 100, count: 2, recordedCount: 1 },
          },
      now,
    ),
  };
});
window.fetch = (input) => {
  const path = new URL(
    input instanceof Request ? input.url : input.toString(),
    location.origin,
  ).pathname;
  let data: unknown = [];
  if (path === "/api/v1/auth/session")
    data = { expiresAt: stamp(-3600000), sensitiveUntil: stamp(-3600000) };
  else if (path === "/api/v1/executions") data = records;
  else if (path.startsWith("/api/v1/executions/"))
    data = records.find((r) => path.endsWith(r.id));
  else if (path === "/api/v1/ai/usage")
    data = {
      generatedAt: stamp(0),
      timeZone: "Asia/Shanghai",
      hours: 24,
      bucketMinutes: 5,
      providers: [],
      periods: [],
      series: [],
    };
  else if (path === "/api/v1/scheduled-tasks")
    data = { items: [], hasMore: false };
  else if (path === "/api/v1/ai/memory/settings")
    data = { enabled: false, generations: [] };
  return Promise.resolve(
    new Response(JSON.stringify({ data, page: { nextCursor: null } }), {
      headers: { "content-type": "application/json" },
    }),
  );
};
const pinia = createPinia();
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/", component: ExecutionsView }],
});
await router.push("/");
await useSessionStore(pinia).restore();
createApp({
  render: () => h("main", { class: "app-shell" }, [h(ExecutionsView)]),
})
  .use(pinia)
  .use(router)
  .mount("#app");
