// Fictional development-only preview, using production components and no external calls.
import { createApp, h, ref } from "vue";
import ImageReplySettings from "../components/workflow/ImageReplySettings.vue";
import GeneratedImageDeliveries from "../components/GeneratedImageDeliveries.vue";
import {
  type ImageReply,
  replyFileTypes,
} from "../../../../modules/generated-images/image-policy";
import "../styles/tokens.css";
import "../styles/base.css";
const pluginId = "00000000-0000-4000-8000-000000000001";
const config = ref<ImageReply>({
  enabled: true,
  pluginId,
  server: "sandbox",
  allowedTypes: ["png", "pdf", "xlsx", "csv", "txt", "md", "zip", "jpeg"],
});
const unlocked = ref(false);
const items = [
  {
    id: "png",
    filename: "虚构统计图.png",
    fileType: "png",
    mimeType: "image/png",
    width: 1200,
    height: 800,
    size: 120000,
    state: "bound",
    deliveryStatus: "confirmed",
  },
  {
    id: "xlsx",
    filename: "示例数据清洗结果与统计汇总_含较长说明的工作表.xlsx",
    fileType: "xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    width: null,
    height: null,
    size: 24000,
    state: "bound",
    deliveryStatus: "confirmed",
  },
  {
    id: "pdf",
    filename: "虚构分析报告.pdf",
    fileType: "pdf",
    mimeType: "application/pdf",
    width: null,
    height: null,
    size: 85000,
    state: "bound",
    deliveryStatus: "failed",
    errorCode: "FILE_SEND_FAILED",
  },
  {
    id: "zip",
    filename: "虚构结果归档.zip",
    fileType: "zip",
    mimeType: "application/zip",
    width: null,
    height: null,
    size: 230000,
    state: "deleted",
    deliveryStatus: "unknown",
  },
];
window.fetch = (url) =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        data: (typeof url === "string"
          ? url
          : url instanceof URL
            ? url.href
            : url.url
        ).includes("image-export-targets")
          ? [
              {
                pluginId,
                pluginName: "示例沙箱",
                server: "sandbox",
                fileTypes: replyFileTypes,
                version: 1,
              },
            ]
          : items,
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
createApp({
  render: () =>
    h("main", { style: "max-width:800px;margin:24px auto;padding:0 16px" }, [
      h("h1", "附件回复 · 本地模拟"),
      h("p", "虚构数据，仅验证配置与审计布局，不操作生产环境。"),
      h(
        "section",
        { class: "admin-panel", style: "padding:20px;margin-bottom:20px" },
        [
          h(ImageReplySettings, {
            modelValue: config.value,
            pluginIds: [pluginId],
            outputFormat: "text",
            "onUpdate:modelValue": (value: ImageReply) => {
              config.value = value;
            },
          }),
        ],
      ),
      h("section", { class: "admin-panel", style: "padding:20px" }, [
        h(
          "button",
          {
            onClick: () => {
              unlocked.value = !unlocked.value;
            },
          },
          unlocked.value ? "模拟锁定" : "模拟解锁",
        ),
        h(GeneratedImageDeliveries, {
          executionId: "00000000-0000-4000-8000-000000000002",
          sensitiveActive: unlocked.value,
        }),
      ]),
    ]),
}).mount("#app");
