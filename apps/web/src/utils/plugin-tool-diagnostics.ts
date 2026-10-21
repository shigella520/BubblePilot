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
    title: server && tool ? `${server} / ${tool}` : (tool ?? item.toolName),
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
    PLUGIN_MCP_TIMEOUT: "MCP 请求超时",
    PLUGIN_MCP_TRANSPORT_ERROR: "MCP 连接或传输失败",
    PLUGIN_MCP_PROTOCOL_ERROR: "MCP 协议错误",
  };
  return code ? (labels[code] ?? null) : null;
}
