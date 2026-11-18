// Development-only preview. All API calls use fictional in-memory data.
import { createApp, h } from "vue";
import { createPinia } from "pinia";
import PluginsView from "../views/PluginsView.vue";
import { useSessionStore } from "../stores/session";
import "../styles/tokens.css";
import "../styles/base.css";
const tool = {
  server: "demo",
  hash: "fictional",
  definition: { name: "read_public_page", description: "读取虚构网页内容。" },
};
const plugin = {
  id: "fictional-plugin",
  name: "示例网页插件",
  enabled: true,
  version: 2,
  revision: "fictional-revision",
  package_version: "1.0.0",
  metadata: { skills: 0, servers: 1 },
  source: { type: "zip" },
  package: { name: "示例网页插件", version: "1.0.0", skills: [], servers: [] },
  config: {
    autoSyncTools: false,
    tools: [tool],
    connections: {},
    disabledSkills: [],
    disabledTools: [],
  },
  references: [],
  versions: [],
  pendingReview: ["demo/read_public_page"],
  pending_review: ["demo/read_public_page"],
  toolSyncLastCheck: "2026-11-18T05:00:00Z",
  toolSyncHistory: [
    {
      checkedAt: "2026-11-18T05:00:00Z",
      source: "scheduled",
      status: "review",
      changes: [
        {
          tool: "demo/read_public_page",
          kind: "review",
          paths: [
            "/definition/parameters/required",
            "/definition/parameters/properties/fictional_long_property_name_for_layout_check/type",
          ],
        },
      ],
    },
    {
      checkedAt: "2026-11-18T04:00:00Z",
      source: "call",
      status: "updated",
      changes: [
        { tool: "demo/read_public_page", kind: "format", paths: ["/format"] },
      ],
    },
  ],
};
window.fetch = (input, init) => {
  const path = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    window.location.origin,
  ).pathname;
  let data: unknown;
  if (path === "/api/v1/auth/session")
    data = {
      authenticated: true,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      sensitiveUntil: new Date(Date.now() + 3600000).toISOString(),
    };
  else if (path === "/api/v1/plugins") data = [plugin];
  else if (path === `/api/v1/plugins/${plugin.id}`) data = plugin;
  else if (
    path === `/api/v1/plugins/${plugin.id}/config` &&
    init?.method === "PUT"
  ) {
    const body = JSON.parse(
      typeof init.body === "string" ? init.body : "{}",
    ) as {
      autoSyncTools: boolean;
      expectedVersion: number;
    };
    if (body.expectedVersion !== plugin.version)
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: "PLUGIN_CONFLICT" } }), {
          status: 409,
        }),
      );
    plugin.config.autoSyncTools = body.autoSyncTools;
    plugin.version++;
    data = plugin;
  } else
    return Promise.resolve(
      new Response(JSON.stringify({ error: { code: "PREVIEW_ONLY" } }), {
        status: 400,
      }),
    );
  return Promise.resolve(
    new Response(JSON.stringify({ data }), {
      headers: { "content-type": "application/json" },
    }),
  );
};
const pinia = createPinia();
createApp({ render: () => h("main", { class: "app-shell" }, [h(PluginsView)]) })
  .use(pinia)
  .mount("#app");
await useSessionStore(pinia).restore();
