// Development-only entry. Uses fictional data and never contacts a production API.
import { createApp, h } from "vue";
import IdleAuditPanel from "../components/workflow/IdleAuditPanel.vue";
import "../styles/tokens.css";
import "../styles/base.css";
const now = Date.now();
const stamp = (minutes: number) =>
  new Date(now - minutes * 60000).toISOString();
const attempts = Array.from({ length: 14 }, (_, i) => ({
  id: `fictional-${i}`,
  chatId: i % 2 ? "fictional-book" : "fictional-walk",
  chatName: i % 2 ? "周末读书会" : "城市散步小队",
  createdAt: stamp(i * 35 + 3),
  completedAt: stamp(i * 35 + 2.8),
  version: 8 - Math.floor(i / 5),
  status: i % 4 === 0 ? "skipped" : i % 4 === 3 ? "failed" : "succeeded",
  reason:
    i % 4 === 0
      ? "idle-model-skip"
      : i % 4 === 3
        ? "AI_PROVIDER_TIMEOUT"
        : null,
  skipReason: i === 0 ? "user-unavailable" : i === 4 ? "repetitive" : null,
  requestCount: i % 3 === 0 ? 2 : 1,
  requests: [
    ...(i % 3 === 0
      ? [
          {
            provider: "示例首选渠道",
            model: "demo-model",
            status: "failed",
            httpStatus: 530,
          },
        ]
      : []),
    {
      provider: "示例 AI 渠道",
      model: "demo-model",
      status: i % 4 === 3 ? "failed" : "succeeded",
      httpStatus: i % 4 === 3 ? 504 : 200,
    },
  ],
  provider: "示例 AI 渠道",
  model: "demo-model",
}));
const rows = [
  {
    chatId: "fictional-walk",
    chatName: "城市散步小队",
    lastActivityAt: stamp(5),
    earliestTriggerAt: null,
    reason: "waiting-for-human",
    workflowRemaining: 4,
    dailyLimit: 4,
    latest: attempts[0],
  },
  {
    chatId: "fictional-book",
    chatName: "周末读书会",
    lastActivityAt: stamp(1),
    earliestTriggerAt: stamp(-1),
    reason: "waiting-for-idle",
    workflowRemaining: 3,
    dailyLimit: 4,
    latest: attempts[1],
  },
];
window.fetch = (input) => {
  const url = new URL(
    input instanceof Request ? input.url : input.toString(),
    location.origin,
  );
  const secondWorkflow = url.pathname.includes("fictional-assistant");
  let data: unknown = [];
  if (url.pathname === "/api/v1/workflows")
    data = [
      {
        id: "fictional-workflow",
        name: "漫游者 · 示例角色",
        publishedVersion: 8,
      },
      {
        id: "fictional-assistant",
        name: "读书助手 · 示例角色",
        publishedVersion: 3,
      },
    ];
  else if (url.pathname.endsWith("idle-preview"))
    data = secondWorkflow
      ? rows.filter((row) => row.chatId === "fictional-book")
      : rows;
  else if (url.pathname.endsWith("idle-history")) {
    const filtered = attempts.filter(
      (a) =>
        (!secondWorkflow || a.chatId === "fictional-book") &&
        (!url.searchParams.get("chatId") ||
          a.chatId === url.searchParams.get("chatId")) &&
        (!url.searchParams.get("status") ||
          a.status === url.searchParams.get("status")),
    );
    const offset = Number(url.searchParams.get("offset") ?? 0),
      limit = Number(url.searchParams.get("limit") ?? 10);
    data = {
      items: filtered.slice(offset, offset + limit),
      hasMore: filtered.length > offset + limit,
    };
  } else if (url.pathname.endsWith("settings/idle"))
    data = { timeZone: "Asia/Shanghai" };
  return Promise.resolve(
    new Response(JSON.stringify({ data }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
};
createApp({
  render: () =>
    h("main", { style: "max-width:1440px;margin:auto;padding:32px 24px" }, [
      h(
        "header",
        {
          style:
            "display:flex;justify-content:space-between;align-items:center;margin-bottom:24px",
        },
        [
          h("div", [
            h(
              "small",
              { style: "color:#1686dc;letter-spacing:2px" },
              "BUBBLEPILOT / LOCAL PREVIEW",
            ),
            h("h1", "执行与审计"),
          ]),
          h(
            "span",
            {
              style:
                "padding:10px 16px;border-radius:20px;background:#e9f6ef;color:#28765b",
            },
            "模拟数据 · 不调用模型或发送消息",
          ),
        ],
      ),
      h("section", { class: "admin-panel" }, [
        h("h2", "历史索引任务"),
        h("p", "模拟任务 · 历史归档索引已完成 · 120 条"),
      ]),
      h(IdleAuditPanel),
      h("section", { class: "admin-panel" }, [
        h("h2", "工作流执行"),
        h("p", "模拟执行列表 · 在生产页面中可查看普通消息和空闲执行详情。"),
      ]),
    ]),
}).mount("#app");
