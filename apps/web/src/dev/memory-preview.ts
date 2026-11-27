// Development-only fictional data. No request is forwarded to a real service.
import { createApp, h } from "vue";
import { createPinia } from "pinia";
import { useSessionStore } from "../stores/session";
import MemorySettingsPanel from "../components/MemorySettingsPanel.vue";
import "../styles/tokens.css";
import "../styles/base.css";

const now = Date.now();
const iso = (ms: number) => new Date(now - ms).toISOString();
const chatIds = Array.from(
  { length: 4 },
  (_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`,
);
window.fetch = (input) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    location.origin,
  );
  let data: unknown = null;
  if (url.pathname === "/api/v1/auth/session")
    data = {
      expiresAt: iso(-3600000),
      sensitiveUntil: iso(-1800000),
    };
  else if (url.pathname === "/api/v1/ai/memory/settings")
    data = {
      enabled: true,
      protocol: "openai-compatible",
      baseUrl: "https://embedding.example.test/compatible-mode/v1",
      model: "fictional-text-embedding",
      dimensions: 1024,
      precision: "float32",
      modelVersion: "1",
      queryPrefix: "",
      timeoutSeconds: 60,
      retentionDays: 3,
      version: 4,
      secretConfigured: true,
      databaseReady: true,
      generations: [
        {
          id: "00000000-0000-4000-8000-0000000000a1",
          model: "fictional-text-embedding",
          dimensions: 1024,
          precision: "float32",
          status: "active",
          createdAt: iso(3600000),
          retiredAt: null,
        },
        {
          id: "00000000-0000-4000-8000-0000000000a2",
          model: "fictional-old-embedding",
          dimensions: 3072,
          precision: "float32",
          status: "retired",
          createdAt: iso(86400000 * 9),
          retiredAt: iso(3600000),
        },
      ],
    };
  else if (url.pathname === "/api/v1/memory/health")
    data = {
      globalEnabled: true,
      generation: {
        id: "00000000-0000-4000-8000-0000000000a1",
        model: "fictional-text-embedding",
        dimensions: 1024,
        precision: "float32",
      },
      chats: chatIds.map((chatId, i) => ({
        chatId,
        enabled: true,
        state: i === 0 ? "indexing" : "healthy",
        total: 1200,
        indexed: i === 0 ? 400 : 1200,
        missing: 0,
        progress: i === 0 ? { total: 1200, done: 400, percent: 33 } : null,
        retryAt: null,
        error: null,
      })),
    };
  return Promise.resolve(
    new Response(JSON.stringify({ data, page: { nextCursor: null } }), {
      headers: { "content-type": "application/json" },
    }),
  );
};
const pinia = createPinia();
const app = createApp({
  render: () =>
    h("main", { class: "app-shell" }, [
      h("section", { class: "admin-panel" }, [h(MemorySettingsPanel)]),
    ]),
});
app.use(pinia);
await useSessionStore(pinia).restore();
app.mount("#app");
