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
  if (item.requestDetails?.kind !== "plugin") return null;
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
    title: ["read_tool_result", "search_tool_result"].includes(item.toolName)
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
    PLUGIN_REMOTE_TOOL_ERROR: "MCP 服务返回工具执行失败；未记录具体原因",
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
