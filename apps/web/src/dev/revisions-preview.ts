// Development-only: actual view, fictional data, no external API requests.
import { createApp, h } from "vue";
import { createPinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import AppHeader from "../components/AppHeader.vue";
import MessagesView from "../views/MessagesView.vue";
import { useSessionStore } from "../stores/session";
import "../styles/tokens.css";
import "../styles/base.css";

const chat = {
  id: "fictional-chat",
  providerChatId: "fictional-chat",
  displayName: "虚构读书会",
  type: "group",
  enabled: true,
  memoryAuthorized: true,
  messageCount: 23,
  version: 1,
  updatedAt: new Date().toISOString(),
};
const directNamesPreview = new URLSearchParams(location.search).has(
  "directNames",
);
const directIdentities: Array<{
  realName: string | null;
  nickname: string | null;
}> = [
  { realName: "林一", nickname: "小林" },
  { realName: null, nickname: "阿禾" },
  { realName: null, nickname: null },
];
const directNames = directIdentities.map((identity, index) => ({
  ...chat,
  id: `fictional-direct-${index}`,
  providerChatId: `iMessage;-;+1555010012${index}`,
  type: "direct",
  peer: `+1555010012${index}`,
  identity,
  identityVersion: 1,
}));
const imagePreview = new URLSearchParams(location.search).has("imageSummary");
const messages = [
  ...(imagePreview
    ? [
        {
          id: "fictional-image-reuse",
          body: "虚构图片摘要复用预览",
          revisionState: "active",
          attachments: [
            {
              providerAttachmentId: "fictional-image",
              fileName: "fictional.png",
              mimeType: "image/png",
              sizeBytes: 2048,
            },
          ],
          contentType: "mixed",
        },
      ]
    : []),
  {
    id: "fictional-original",
    body: "明天上午十点在图书馆集合，记得带上笔记本。",
    revisionState: "active",
    editedAt: new Date().toISOString(),
  },
  {
    id: "fictional-reply",
    body: "好的，我提前十分钟到。",
    revisionState: "active",
    replyTo: {
      status: "available",
      archive_id: "fictional-original",
      sender_id: "示例成员甲",
      text_preview: "明天上午十点在图书馆集合，记得带上笔记本。",
      truncated: false,
    },
  },
  {
    id: "fictional-retracted",
    body: null,
    revisionState: "retracted",
    retractedBody:
      "虚构示例：周末活动改在下午三点。这段留存正文只向管理页提供。",
  },
  {
    id: "fictional-retracted-old",
    body: null,
    revisionState: "retracted",
    retractedBody: null,
  },
  {
    id: "fictional-partial",
    body: null,
    revisionState: "partial",
    replyTo: { status: "retracted" },
  },
  ...Array.from({ length: 18 }, (_, index) => ({
    id: `fictional-page-${index + 1}`,
    body: `虚构分页消息 ${index + 1}：本周阅读计划与活动安排。`,
    revisionState: "active",
  })),
].map((m) => ({
  ...chat,
  chatId: chat.id,
  chatDisplayName: chat.displayName,
  senderId: "示例成员乙",
  providerMessageId: m.id,
  sentAt: new Date().toISOString(),
  contentType: "text",
  contentRedactedAt: null,
  isFromMe: false,
  attachments: [],
  linkPreview: { status: "not-requested", items: [], errorCode: null },
  executions: [],
  ...m,
}));
window.fetch = (input, init) => {
  const url = new URL(
    input instanceof Request ? input.url : input.toString(),
    location.origin,
  );
  const path = url.pathname;
  let nextCursor: string | null = null;
  let data: unknown = [];
  if (path === "/api/v1/auth/session")
    data = {
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      sensitiveUntil: new Date(Date.now() + 3600000).toISOString(),
    };
  else if (["/api/v1/chats", "/api/v1/chat-monitoring"].includes(path))
    data = directNamesPreview
      ? [
          ...directNames.map((c) => ({
            ...c,
            displayName: c.identity.realName || c.identity.nickname || c.peer,
          })),
          chat,
        ]
      : [chat];
  else if (directNamesPreview && path.endsWith("/participants")) {
    const current = directNames.find((c) => path.includes(c.id))!;
    if (init?.method === "PUT") {
      if (typeof init.body !== "string")
        throw new Error("Expected fictional JSON body");
      const body = JSON.parse(init.body) as {
        identities: Array<{ realName: string | null; nickname: string | null }>;
      };
      current.identity = body.identities[0] ?? {
        realName: null,
        nickname: null,
      };
      current.identityVersion++;
    }
    data = {
      chatId: current.id,
      version: current.identityVersion,
      participants: [
        {
          senderId: current.peer,
          ...current.identity,
          messageCount: 23,
          lastSeenAt: new Date().toISOString(),
        },
      ],
    };
  } else if (path === "/api/v1/bot-attributions")
    data = { chats: [], jobs: [] };
  else if (path === "/api/v1/memory/health")
    data = {
      globalEnabled: true,
      generation: {
        id: "fictional-generation",
        model: "fictional-embedding",
        dimensions: 1024,
        precision: "float32",
      },
      chats: [
        {
          chatId: chat.id,
          enabled: true,
          state: "missing",
          total: 23,
          indexed: 20,
          missing: 3,
          progress: null,
          retryAt: null,
          error: null,
        },
      ],
    };
  else if (path === `/api/v1/chats/${chat.id}/memory`)
    data = {
      enabled: true,
      version: 1,
      upperIndex: 24,
      coverage: { total: 23, indexed: 20, pending: 3, failed: 0 },
    };
  else if (path === "/api/v1/messages/search") {
    const query = url.searchParams.get("q") ?? "";
    const matching = messages.filter((message) =>
      (message.body ?? "").includes(query),
    );
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    data = matching.slice(offset, offset + limit);
    nextCursor =
      offset + limit < matching.length ? String(offset + limit) : null;
  } else if (imagePreview && path.endsWith("/media")) {
    data = {
      messageId: "fictional-image-reuse",
      contentRedactedAt: null,
      items: ["cache", "model", "legacy"].map((origin, index) => ({
        attachmentRef: `fictional-image-${index}`,
        sourceType: "attachment",
        label: "虚构图片",
        fileName: `fictional-${origin}.png`,
        declaredMimeType: "image/png",
        sizeBytes: 2048,
        summaryStatus: "succeeded",
        summary: "一张虚构的蓝色方块图片。",
        providerName: "Fictional vision",
        model: "fictional-vision",
        contractVersion: "image-summary-v1",
        attemptCount: 1,
        providerAttemptCount: origin === "cache" ? 0 : 1,
        resultOrigin: origin,
        errorCode: null,
        durationMs: origin === "cache" ? 8 : 400,
        generatedAt: "2026-11-19T04:00:00.000Z",
        reusedAt: origin === "cache" ? "2026-11-20T04:00:00.000Z" : null,
        imageContentHash: "sha256:fictional",
        routeTraces: [],
        previewUrl:
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='100'%3E%3Crect width='160' height='100' fill='%23006cbe'/%3E%3C/svg%3E",
      })),
    };
  } else if (path.startsWith("/api/v1/messages/"))
    data = messages.find((m) => m.id === path.split("/").at(-1));
  return Promise.resolve(
    new Response(JSON.stringify({ data, page: { nextCursor } }), {
      headers: { "content-type": "application/json" },
    }),
  );
};
const pinia = createPinia();
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/:pathMatch(.*)*", component: MessagesView }],
});
await router.push("/messages");
await router.isReady();
createApp({
  render: () =>
    h("div", { class: "app-shell" }, [h(AppHeader), h(MessagesView)]),
})
  .use(pinia)
  .use(router)
  .mount("#app");
await useSessionStore(pinia).restore();
