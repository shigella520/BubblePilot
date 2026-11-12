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
  messageCount: 4,
  version: 1,
  updatedAt: new Date().toISOString(),
};
const messages = [
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
window.fetch = (input) => {
  const path = new URL(
    input instanceof Request ? input.url : input.toString(),
    location.origin,
  ).pathname;
  let data: unknown = [];
  if (path === "/api/v1/auth/session")
    data = {
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      sensitiveUntil: new Date(Date.now() + 3600000).toISOString(),
    };
  else if (["/api/v1/chats", "/api/v1/chat-monitoring"].includes(path))
    data = [chat];
  else if (path === "/api/v1/bot-attributions") data = { chats: [], jobs: [] };
  else if (path === "/api/v1/messages/search") data = messages;
  else if (path.startsWith("/api/v1/messages/"))
    data = messages.find((m) => m.id === path.split("/").at(-1));
  return Promise.resolve(
    new Response(JSON.stringify({ data, page: { nextCursor: null } }), {
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
