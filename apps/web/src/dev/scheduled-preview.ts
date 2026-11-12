// Development-only fictional data. No request is forwarded to a real service.
import { createApp, h } from "vue";
import {
  schedulePreview,
  scheduleSummary,
  type TaskSchedule,
} from "../../../../modules/scheduled-tasks/task-schedule";
import { createRouter, createWebHashHistory } from "vue-router";
import { FileClock } from "@lucide/vue";
import SectionNavigation from "../components/SectionNavigation.vue";
import { createPinia } from "pinia";
import { useSessionStore } from "../stores/session";
import ScheduledTasksPanel from "../components/workflow/ScheduledTasksPanel.vue";
import "../styles/tokens.css";
import "../styles/base.css";
const tasks = Array.from({ length: 5 }, (_, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i + 1}`,
  summary: i === 0 ? "读书会场地预订" : null,
  content: [
    "提醒预订读书会场地。先整理参与人数和候选地点，再根据群内讨论汇总交通方式。\n这是虚构的长任务内容，用于检查列表是否简洁，详情是否完整保留后续说明。",
    "提醒检查读书会报名并整理所有成员的到场时间和需要携带的书籍以及共享资料清单随后汇总尚未确认的事项并在活动开始前再次核对场地安排与座位数量",
    "提醒带雨伞",
    "提醒提交周末计划",
    "提醒喝水",
  ][i],
  schedule: (i === 0
    ? {
        kind: "recurring",
        startsAt: new Date(Date.now() + 3600000).toISOString(),
        rule: { type: "weekly", weekdays: [1, 3, 5], localTime: "09:00" },
        end: { kind: "count", count: 12 },
      }
    : {
        kind: "once",
        scheduledAt: new Date(Date.now() + 3600000).toISOString(),
      }) satisfies TaskSchedule,
  lifecycle: i === 0 ? "active" : i === 2 ? "cancelled" : "completed",
  consumedCount: i === 0 ? 2 : 1,
  scheduledAt: new Date(Date.now() + 3600000).toISOString(),
  timeZone: "UTC",
  status: ["pending", "sent", "cancelled", "delivery_unknown", "failed"][i],
  version: 1,
  chatId: i % 2 ? "chat-book" : "chat-travel",
  chatName: i % 2 ? "周末读书会" : "旅行讨论组",
  workflowId: i % 2 ? "role-book" : "role-lanbo",
  workflowName: i % 2 ? "书友" : "兰博",
  creatorSenderId: "fictional-member",
})).map((t) => ({
  ...t,
  scheduleSummary: scheduleSummary(t.schedule),
  upcoming: schedulePreview(
    t.schedule,
    t.timeZone,
    new Date(),
    t.consumedCount,
  ),
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
  else if (url.pathname === "/api/v1/scheduled-tasks/preview") {
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as {
      schedule: TaskSchedule;
      timeZone: string;
      consumedCount: number;
    };
    data = {
      scheduleSummary: scheduleSummary(body.schedule),
      upcoming: schedulePreview(
        body.schedule,
        body.timeZone,
        new Date(),
        body.consumedCount,
      ),
    };
  } else if (url.pathname.startsWith("/api/v1/scheduled-tasks/")) {
    const task = tasks.find((t) => url.pathname.includes(t.id));
    if (task && init?.method === "DELETE") {
      tasks.splice(tasks.indexOf(task), 1);
      data = { id: task.id, deleted: true };
    } else if (task && init?.method === "POST") {
      task.status = url.pathname.endsWith("/pause")
        ? "paused"
        : url.pathname.endsWith("/cancel")
          ? "cancelled"
          : "pending";
      task.lifecycle =
        task.status === "paused"
          ? "paused"
          : task.status === "cancelled"
            ? "cancelled"
            : "active";
      if (url.pathname.endsWith("/skip-next")) task.consumedCount++;
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
        summary: task,
        occurrences:
          task.schedule.kind === "recurring"
            ? [0, 1].map((i) => ({
                id: `occurrence-${i}`,
                occurrence_number: String(2 - i),
                scheduled_at: new Date(
                  Date.now() - (i + 1) * 86400000,
                ).toISOString(),
                status: i === 0 ? "sent" : "skipped",
                reason_code: i === 0 ? null : "member-skipped",
                execution_id: null,
              }))
            : [],
        hasMore: false,
        task: {
          summary: task.summary,
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
const sections = [
  { id: "idle-conversations", label: "空闲主动交流", icon: FileClock },
  { id: "scheduled-tasks", label: "定时任务", icon: FileClock },
  { id: "executions", label: "执行记录", icon: FileClock },
  { id: "audit", label: "审计事件", icon: FileClock },
];
const router = createRouter({
  history: createWebHashHistory(),
  routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }],
});
const placeholder = (id: string, label: string) =>
  h("section", { id, class: "admin-panel", style: "min-height:65vh" }, [
    h("h2", label),
    h("p", "虚构占位模块，用于验证导航顺序与跳转。"),
  ]);
const app = createApp({
  render: () =>
    h(
      "main",
      { class: "page-container split-admin-page", style: "padding:24px" },
      [
        h("aside", { class: "admin-sidebar" }, [
          h(SectionNavigation, { items: sections }),
        ]),
        h("div", { class: "admin-workspace" }, [
          h("p", "定时任务 · 本地虚构数据预览，不会登记或发送真实提醒。"),
          placeholder("idle-conversations", "空闲主动交流"),
          h(ScheduledTasksPanel, { id: "scheduled-tasks" }),
          placeholder("executions", "执行记录"),
          placeholder("audit", "审计事件"),
        ]),
      ],
    ),
});
app.use(router);
await router.isReady();
const pinia = createPinia();
app.use(pinia);
await useSessionStore(pinia).restore();
app.mount("#app");
