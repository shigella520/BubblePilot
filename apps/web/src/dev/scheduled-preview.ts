// Development-only fictional data. No request is forwarded to a real service.
import { createApp, h } from "vue";
import { createPinia } from "pinia";
import { useSessionStore } from "../stores/session";
import ScheduledTasksPanel from "../components/workflow/ScheduledTasksPanel.vue";
import "../styles/tokens.css";
import "../styles/base.css";
const tasks = Array.from({ length: 5 }, (_, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i + 1}`,
  content: [
    "提醒我抢火车票",
    "提醒检查读书会报名",
    "提醒带雨伞",
    "提醒提交周末计划",
    "提醒喝水",
  ][i],
  scheduledAt: new Date(Date.now() + (i - 2) * 3600000).toISOString(),
  timeZone: "Asia/Shanghai",
  status: ["pending", "sent", "cancelled", "delivery_unknown", "failed"][i],
  version: 1,
  chatId: i % 2 ? "chat-book" : "chat-travel",
  chatName: i % 2 ? "周末读书会" : "旅行讨论组",
  workflowId: i % 2 ? "role-book" : "role-lanbo",
  workflowName: i % 2 ? "书友" : "兰博",
  creatorSenderId: "fictional-member",
}));
window.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    location.origin,
  );
  let data: unknown = null;
  let page: unknown;
  if (url.pathname === "/api/v1/auth/session")
    data = {
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      sensitiveUntil: new Date(Date.now() + 300000).toISOString(),
    };
  else if (url.pathname === "/api/v1/workflows")
    data = [
      { id: "role-lanbo", name: "兰博" },
      { id: "role-book", name: "书友" },
    ];
  else if (url.pathname === "/api/v1/chats") {
    data = [
      { id: "chat-travel", displayName: "旅行讨论组" },
      { id: "chat-book", displayName: "周末读书会" },
    ];
    page = { nextCursor: null };
  } else if (url.pathname === "/api/v1/settings/scheduled-tasks")
    data = {
      paused: false,
      pending_limit: 1000,
      catchup_minutes: 30,
      version: 1,
    };
  else if (url.pathname === "/api/v1/scheduled-tasks")
    data = {
      items: tasks.filter(
        (t) =>
          (!url.searchParams.get("workflowId") ||
            t.workflowId === url.searchParams.get("workflowId")) &&
          (!url.searchParams.get("chatId") ||
            t.chatId === url.searchParams.get("chatId")) &&
          (!url.searchParams.get("status") ||
            t.status === url.searchParams.get("status")),
      ),
      hasMore: false,
    };
  else if (url.pathname.startsWith("/api/v1/scheduled-tasks/")) {
    const task = tasks.find((t) => url.pathname.includes(t.id));
    if (task && init?.method === "POST") {
      task.status = "cancelled";
      task.version++;
      data = task;
    } else if (task && init?.method === "PATCH") {
      const changes = JSON.parse(
        typeof init.body === "string" ? init.body : "{}",
      ) as {
        content?: string;
        scheduledAt?: string;
      };
      Object.assign(task, changes, { version: task.version + 1 });
      data = task;
    } else if (task)
      data = {
        task: {
          content: task.content,
          request_snapshot: "兰博，明天早上五点提醒我抢火车票。",
          status: task.status,
          scheduled_at: task.scheduledAt,
          timezone: task.timeZone,
          creator_sender_id: "fictional-member",
        },
        events: [
          {
            id: "event",
            event_type: "created",
            created_at: new Date().toISOString(),
            reason_code: null,
          },
        ],
        runs: [],
      };
  }
  return Promise.resolve(
    new Response(JSON.stringify({ data, ...(page ? { page } : {}) }), {
      status: data === null ? 404 : 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
};
const app = createApp({
  render: () =>
    h("main", { style: "max-width:1440px;margin:auto;padding:24px" }, [
      h("p", "定时任务 · 本地虚构数据预览，不会登记或发送真实提醒。"),
      h(ScheduledTasksPanel),
    ]),
});
const pinia = createPinia();
app.use(pinia);
await useSessionStore(pinia).restore();
app.mount("#app");
