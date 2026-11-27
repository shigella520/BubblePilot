type Details = Record<string, unknown> | null;
interface ToolRecord {
  toolName: string;
  nodeId: string;
  requestDetails: Details;
  responseDetails: Details;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function pluginToolPresentation(
  item: ToolRecord,
  nodes: Array<{ nodeId: string; outputSummary: unknown }> = [],
) {
  if (!["plugin", "attachment"].includes(String(item.requestDetails?.kind)))
    return null;
  const field = (key: string) => {
    const value = item.requestDetails?.[key] ?? item.responseDetails?.[key];
    return typeof value === "string" && value ? value : null;
  };
  const id = field("pluginId");
  const revision = field("revision");
  // Old calls can use the pinned execution snapshot, never the current install.
  const names = new Set<string>();
  if (id && revision)
    for (const node of nodes.filter((node) => node.nodeId === item.nodeId)) {
      const plugins = record(record(node.outputSummary).agentBudget).plugins;
      if (!Array.isArray(plugins)) continue;
      for (const value of plugins) {
        const plugin = record(value);
        if (
          plugin.id === id &&
          plugin.revision === revision &&
          typeof plugin.name === "string" &&
          plugin.name
        )
          names.add(plugin.name);
      }
    }
  const server = field("server");
  const tool = field("tool");
  return {
    title:
      item.toolName === "import_chat_attachment"
        ? `${field("target") === "image_generator" ? "图片导入（生图）" : "附件导入"} · ${server ?? "目标"}`
        : ["read_tool_result", "search_tool_result"].includes(item.toolName)
          ? `${item.toolName === "read_tool_result" ? "读取结果" : "搜索结果"} · ${server ?? ""} / ${tool ?? ""}`
          : server && tool
            ? `${server} / ${tool}`
            : (tool ?? item.toolName),
    plugin:
      field("pluginName") ??
      (names.size === 1 ? [...names][0] : "未记录插件名称"),
    server,
    revision,
    id,
  };
}

export function pluginToolErrorLabel(code: string | null) {
  const labels: Record<string, string> = {
    ATTACHMENT_REFERENCE_UNAVAILABLE: "附件引用不属于本次运行，或尚未发现",
    ATTACHMENT_PERMISSION_REVOKED: "附件来源或聊天授权已失效",
    ATTACHMENT_TYPE_UNSUPPORTED_OR_CONFLICTING: "附件类型不支持或声明冲突",
    ATTACHMENT_TYPE_MISMATCH: "文件内容与声明类型不符",
    ATTACHMENT_TEXT_ENCODING_UNSUPPORTED: "暂不支持此文本编码或内容不是文本",
    ATTACHMENT_TOO_LARGE: "附件超过单文件或任务剩余额度",
    ATTACHMENT_COUNT_LIMIT: "本次任务的文件数量已达上限",
    ATTACHMENT_CAPACITY_BUSY: "附件临时存储容量不足或正在导入",
    ATTACHMENT_UNAVAILABLE: "网关已不再保留此附件",
    ATTACHMENT_DOWNLOAD_FAILED: "附件下载失败",
    ATTACHMENT_TIMEOUT_OR_CANCELLED: "附件导入超时或已取消，会话已清理",
    ATTACHMENT_IMPORT_FAILED: "附件传输未完成，请查看服务状态",
    ATTACHMENT_SESSION_INVALIDATED: "本次任务的附件会话已失效",

    PLUGIN_REMOTE_TOOL_ERROR: "MCP 服务返回工具执行失败；未记录具体原因",
    PLUGIN_COMMAND_FAILED: "命令已退出但执行失败；请检查退出码和具体原因",
    PLUGIN_COMMAND_OUTPUT_LIMIT: "命令输出超过限制，本次沙箱已失效",
    PLUGIN_MCP_CANCELLED: "MCP 请求已取消，不能自动重放未知操作",
    PLUGIN_COMMAND_RESULT_UNKNOWN: "命令结果未知，本次沙箱已失效，不能自动重放",
    PLUGIN_SESSION_INVALIDATED: "本次沙箱会话已失效或过期",
    IMAGE_PREPARATION_FAILED: "附件准备失败，未选中可发送文件",
    IMAGE_SESSION_UNAVAILABLE: "附件准备会话不可用，未选中可发送文件",
    IMAGE_ANIMATION_LIMIT:
      "GIF 超过 200 帧或累计 6400 万像素，请减少帧数或尺寸",
    IMAGE_INVALID: "图片损坏或无法完整解码",
    IMAGE_PIXELS_EXCEEDED: "图片尺寸或像素数超过限制",
    IMAGE_TOO_LARGE: "图片超过 8 MiB 限制",
    FILE_TYPE_NOT_AUTHORIZED: "工作流未允许回复此文件类型",
    FILE_TYPE_MISMATCH: "文件内容与扩展名不符",
    IMAGE_ARGUMENTS_INVALID: "附件路径参数无效",
    IMAGE_PATH_DENIED: "附件路径必须是 /workspace/ 下的绝对路径",
    IMAGE_EXPORT_TIMEOUT: "附件导出超时或已取消，未选中可发送文件",
    PLUGIN_REMOTE_AUTH_DENIED: "MCP 服务拒绝认证，请检查凭据",
    PLUGIN_QUOTA_EXHAUSTED: "服务额度已耗尽",
    PLUGIN_BILLING_REQUIRED: "服务要求付费或补充额度",
    PLUGIN_RATE_LIMITED: "服务请求频率受限",
    PLUGIN_RESULT_BUDGET: "工具结果无法容纳在剩余文字预算内",
    PLUGIN_RESULT_STORAGE_LIMIT: "本次运行的完整结果暂存容量已满",
    PLUGIN_RESPONSE_TOO_LARGE: "MCP 网络响应超过大小上限",
    PLUGIN_REFERENCE_UNAVAILABLE: "结果引用不可用或已释放",
    PLUGIN_PERMISSION_REVOKED: "插件或工具授权已撤销",
    PLUGIN_MCP_TIMEOUT: "MCP 请求超时",
    PLUGIN_MCP_TRANSPORT_ERROR: "MCP 连接或传输失败",
    PLUGIN_MCP_PROTOCOL_ERROR: "MCP 协议错误",
  };
  return code ? (labels[code] ?? null) : null;
}

export function pluginCommandErrorLabel(details: Details) {
  const labels: Record<string, string> = {
    svg_path_denied: "渲染路径必须是 /workspace/ 下的绝对路径",
    svg_namespace_required: "SVG 缺少正确的命名空间",
    svg_not_regular: "SVG 输入不是普通文件",
    svg_entities_unsupported: "SVG 不允许实体声明",
    svg_element_unsupported: "SVG 包含不支持的元素",
    svg_attribute_unsupported: "SVG 包含不支持的属性",
    svg_external_resource_denied: "SVG 不允许外部资源",
    svg_source_too_large: "SVG 源文件过大",
    svg_dimensions_invalid: "SVG 尺寸无效",
    svg_dimensions_exceeded: "SVG 尺寸超过限制",
    svg_complexity_exceeded: "SVG 复杂度超过限制",
    svg_render_failed: "SVG 渲染失败",
    png_too_large: "渲染生成的 PNG 文件超过大小限制",
    png_dimensions_invalid: "渲染生成的 PNG 尺寸无效",
  };
  const reason =
    typeof details?.failureReason === "string"
      ? labels[details.failureReason]
      : null;
  const exit =
    typeof details?.exitCode === "number" ? `退出码 ${details.exitCode}` : null;
  return [exit, reason].filter(Boolean).join(" · ");
}

export function pluginDeliveryLabel(details: Details) {
  if (!details || details.diagnosticVersion !== 1) return "未记录详细交付信息";
  if (details.delivery === "unavailable") return "正文未交付；请查看失败原因";
  if (details.delivery === "partial")
    return "已获取结果，已展示部分内容；运行期间可继续读取";
  if (
    details.delivery === "read" &&
    typeof details.offset === "number" &&
    typeof details.nextOffset === "number"
  )
    return `已读取第 ${details.offset}—${details.nextOffset} 字符（从 0 起算）`;
  if (details.delivery === "search" && typeof details.matchCount === "number")
    return `找到 ${details.matchCount} 处字面匹配`;
  return "结果已完整交付";
}

export function pluginImageRows(
  details: Details,
  attempts: Array<{
    status: string;
    diagnostics?: {
      imageInputs?: {
        dispatched: boolean;
        images: Array<{ imageInputId: string }>;
      } | null;
    } | null;
  }> = [],
) {
  if (!Array.isArray(details?.images)) return [];
  return details.images.map((value, index) => {
    const image = record(value);
    const id = typeof image.imageInputId === "string" ? image.imageInputId : "";
    const sent = attempts.filter(
      (attempt) =>
        attempt.diagnostics?.imageInputs?.dispatched &&
        attempt.diagnostics.imageInputs.images.some(
          (item) => item.imageInputId === id,
        ),
    );
    const state =
      image.status === "omitted"
        ? `未提供图片：${typeof image.reason === "string" ? image.reason : "unknown"}`
        : sent.some((attempt) => attempt.status === "succeeded")
          ? "已携图请求成功（不代表识别正确）"
          : sent.length
            ? "已发起携图请求；结果请查看对应调用"
            : image.status === "committed" ||
                image.status === "already-in-context"
              ? "已纳入运行上下文；未记录实际发送"
              : "图片已准备，未提交";
    return {
      key: `${id}-${index}`,
      id,
      anchorId: image.status === "committed" ? id : "",
      block:
        typeof image.block_index === "number"
          ? image.block_index + 1
          : index + 1,
      state,
      dimensions:
        typeof image.width === "number" && typeof image.height === "number"
          ? `${image.width} × ${image.height}`
          : null,
      bytes: typeof image.bytes === "number" ? image.bytes : null,
      firstFrameOnly: image.firstFrameOnly === true,
    };
  });
}
