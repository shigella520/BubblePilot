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
  metadata: {
    description: "检索公开网页与资料，将网页内容整理成可引用的上下文。",
    skills: 0,
    servers: 1,
  },
  summary: {
    toolsEnabled: 1,
    toolsApproved: 1,
    skillsEnabled: 0,
    skillsTotal: 0,
    servers: 1,
    activeWorkflows: 2,
    autoSyncTools: false,
    lastCheckAt: "2026-11-18T05:00:00Z",
    lastSyncStatus: "review",
  },
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
const cardPreview = new URLSearchParams(location.search).has("cards");
const samples = [
  {
    ...plugin,
    id: "fictional-sandbox",
    name: "示例沙箱工具",
    metadata: {
      description: "执行代码、分析聊天附件，绘制图片并将处理结果作为文件回复。",
      skills: 1,
      servers: 1,
    },
    pending_review: [],
    summary: {
      ...plugin.summary,
      toolsEnabled: 5,
      toolsApproved: 5,
      skillsEnabled: 1,
      skillsTotal: 1,
      autoSyncTools: true,
      lastSyncStatus: "unchanged",
    },
  },
  plugin,
  {
    ...plugin,
    id: "fictional-long",
    name: "fictional-research-and-document-processing-with-an-extremely-long-plugin-name",
    metadata: {
      description: "这是用于布局验证的长简介。".repeat(20),
      skills: 3,
      servers: 2,
    },
    pending_review: ["fictional/" + "long-tool-name".repeat(30), "demo/other"],
    summary: {
      ...plugin.summary,
      toolsEnabled: 100,
      toolsApproved: 100,
      skillsEnabled: 2,
      skillsTotal: 3,
      servers: 2,
      autoSyncTools: true,
      activeWorkflows: 12,
      lastSyncStatus: "failed",
    },
  },
  {
    ...plugin,
    id: "fictional-disabled",
    name: "示例文件整理",
    enabled: false,
    metadata: { description: "整理资料并生成摘要。", skills: 1, servers: 1 },
    pending_review: [],
    summary: {
      ...plugin.summary,
      toolsEnabled: 0,
      skillsEnabled: 1,
      skillsTotal: 1,
      activeWorkflows: 0,
      autoSyncTools: true,
      lastCheckAt: null,
      lastSyncStatus: null,
    },
  },
  {
    ...plugin,
    id: "fictional-skill",
    name: "示例写作指引",
    metadata: { description: "", skills: 2, servers: 0 },
    pending_review: [],
    summary: {
      ...plugin.summary,
      toolsEnabled: 0,
      toolsApproved: 0,
      skillsEnabled: 2,
      skillsTotal: 2,
      servers: 0,
      activeWorkflows: 0,
      lastCheckAt: null,
      lastSyncStatus: null,
    },
  },
  {
    ...plugin,
    id: "fictional-legacy",
    name: "统计暂未提供的插件",
    pending_review: [],
    summary: undefined,
  },
];
const listed = cardPreview ? samples : [plugin];
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
  else if (path === "/api/v1/plugins") data = listed;
  else if (path === "/api/v1/settings/plugins")
    data = {
      catalogueCharacters: 64000,
      version: 1,
      updatedAt: new Date().toISOString(),
      usage: { characters: 0, sharedCharacters: 0, toolCount: 0, plugins: [] },
    };
  else if (listed.some((p) => path === `/api/v1/plugins/${p.id}`)) {
    const selected = listed.find((p) => path === `/api/v1/plugins/${p.id}`)!;
    data = {
      ...selected,
      package: {
        ...plugin.package,
        name: selected.name,
        description: selected.metadata.description,
      },
    };
  } else if (
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
