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
// Query controls exercise authorization expiry and late responses using fictional data only.
const previewOptions = new URLSearchParams(location.search);
let previewUnlocked = !previewOptions.has("locked");
const previewSession = () => ({
  expiresAt: stamp(-3600000),
  sensitiveUntil: previewUnlocked
    ? new Date(
        Date.now() + Number(previewOptions.get("grantMs") ?? 3600000),
      ).toISOString()
    : null,
});
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
    sourceMessageId: `fictional-message-${index}`,
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
  if (path === "/api/v1/auth/session") data = previewSession();
  else if (path === "/api/v1/auth/sensitive") {
    previewUnlocked = true;
    data = previewSession();
  } else if (path === "/api/v1/executions") data = records;
  else if (path.endsWith("/source-message"))
    data = {
      messageId: "fictional-message-1",
      sentAt: stamp(60000),
      senderId: "fictional-sender",
      body:
        "请分析这个示例文件，并列出关键结论。\n" +
        "用于验证长消息换行与滚动的虚构文本。".repeat(150),
      retractedBody: null,
      revisionState: "active",
      editedAt: stamp(50000),
      attachments: [
        {
          fileName: "示例分析文档.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
        },
      ],
    };
  else if (path.endsWith("/generated-images")) data = [];
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
  if (path.endsWith("/source-message") && previewOptions.has("delayMs"))
    return new Promise((resolve) =>
      setTimeout(
        () => resolve(new Response(JSON.stringify({ data }))),
        Number(previewOptions.get("delayMs")),
      ),
    );
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
