// Development-only, fictional configuration. No production API or model calls.
import { createApp, h, ref } from "vue";
import AttachmentHandlingSettings from "../components/workflow/AttachmentHandlingSettings.vue";
import type { AttachmentHandling } from "../../../../modules/attachments/attachment-policy";
import "../styles/tokens.css";
import "../styles/base.css";
const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
];
const selected = ref<string[]>(ids.slice(0, 1));
const config = ref<AttachmentHandling>();
window.fetch = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        data: ids.map((pluginId, i) => ({
          pluginId,
          pluginName: i ? "示例备用沙箱" : "示例本地沙箱",
          server: "sandbox",
          version: 1,
        })),
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
createApp({
  render: () =>
    h("main", { style: "max-width:760px;margin:32px auto;padding:0 20px" }, [
      h("small", { style: "color:#1686dc" }, "BUBBLEPILOT / LOCAL PREVIEW"),
      h("h1", "AI 节点 · 聊天附件处理"),
      h("p", "虚构数据，仅修改页面草稿；不会下载附件、启动沙箱或保存工作流。"),
      h("section", { class: "admin-panel" }, [
        h("h3", "已选插件"),
        ...ids.map((id, i) =>
          h("label", { style: "display:flex;gap:8px;margin:12px 0" }, [
            h("input", {
              type: "checkbox",
              checked: selected.value.includes(id),
              onChange: (event: Event) => {
                selected.value = (event.target as HTMLInputElement).checked
                  ? [...selected.value, id]
                  : selected.value.filter((v) => v !== id);
              },
            }),
            i ? "示例备用沙箱" : "示例本地沙箱",
          ]),
        ),
        h(AttachmentHandlingSettings, {
          modelValue: config.value,
          pluginIds: selected.value,
          outputFormat: "text",
          "onUpdate:modelValue": (value: AttachmentHandling) => {
            config.value = value;
          },
        }),
      ]),
    ]),
}).mount("#app");
