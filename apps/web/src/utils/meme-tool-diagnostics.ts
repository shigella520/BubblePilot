export function memeToolLabel(
  toolName: string,
  details: Record<string, unknown> | null,
): string | null {
  if (!["search_memes", "select_meme"].includes(toolName)) return null;
  if (details?.kind !== "meme" || details.version !== 1)
    return "未记录详细结果";
  const labels: Record<string, string> = {
    "no-results": "未匹配",
    selected: "已选择，待发送",
    cleared: "已清除选择",
    "invalid-selection": "选择无效：素材不是本次返回的候选",
    "invalid-arguments": "参数错误",
    unavailable: "表情工具不可用",
    timeout: "表情工具超时",
    "budget-exhausted": "本次工具预算已耗尽",
  };
  if (details.outcome === "ok")
    return `找到 ${typeof details.returnedCount === "number" ? details.returnedCount : "—"} 张候选${details.truncated ? " · 候选已截断" : ""}`;
  if (
    details.outcome === "unavailable" &&
    details.reason === "asset-unavailable"
  )
    return "素材已不可用";
  if (details.outcome === "unavailable" && details.reason === "query-failed")
    return "表情查询失败";
  return labels[String(details.outcome)] ?? "未记录详细结果";
}
