const stages: Record<string, string> = {
  arguments: "解析参数",
  authorization: "检查聊天权限",
  validation: "校验参数",
  "archive-query": "查询聊天记录",
  coverage: "检查索引覆盖",
  "embedding-identity": "检查向量模型",
  "embedding-query": "生成查询向量",
  "keyword-search": "关键词检索",
  "vector-search": "向量检索",
  "source-read": "读取原文",
  "source-validation": "复核原文和权限",
  "output-fitting": "整理工具结果",
  "record-sources": "记录来源",
  timeout: "工具执行",
};
const fields: Record<string, string> = {
  query: "搜索内容",
  limit: "结果数量",
  from: "开始时间",
  to: "结束时间",
  senderId: "发送者",
  botWorkflowId: "Bot 身份",
  ref: "来源引用",
  before: "向前条数",
  after: "向后条数",
  attachmentOffset: "附件偏移",
  cursor: "分页位置",
  order: "排序",
  groupBy: "分组",
  breakdownBy: "细分分组",
  orderBy: "分组排序",
  pick: "首末选择",
  dailyTime: "每日时段",
};
const issues: Record<string, string> = {
  invalid_type: "类型不正确或缺失",
  too_big: "超出上限",
  too_small: "低于下限",
  invalid_format: "格式不正确",
  invalid_value: "值不受支持",
  unrecognized_keys: "包含不支持的字段",
  invalid_union: "参数格式不正确",
  custom: "参数组合不符合要求",
  other: "不符合要求",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function failureLabel(value: unknown): string | null {
  const failure = asRecord(value);
  if (!failure) return null;
  const stage = stages[String(failure.stage)] ?? "历史检索";
  const category = String(failure.category);
  if (category === "invalid-json") return `${stage}：参数不是有效 JSON`;
  if (category === "invalid-arguments") {
    const detail = Array.isArray(failure.validationIssues)
      ? failure.validationIssues
          .slice(0, 5)
          .flatMap((entry: unknown) => {
            const issue = asRecord(entry);
            if (!issue) return [];
            const label = issues[String(issue.code)];
            if (!label) return [];
            const field = fields[String(issue.field)];
            return [field ? `${field}${label}` : label];
          })
          .join("、")
      : "";
    return `${stage}：参数不符合要求${detail ? `（${detail}）` : ""}`;
  }
  if (category === "embedding-error") {
    const messages: Record<string, string> = {
      MEMORY_MODEL_CHANGED: "向量模型与索引代次不一致",
      MEMORY_MODEL_IDENTITY_UNAVAILABLE: "无法确认向量模型身份",
      MEMORY_EMBEDDING_HTTP_ERROR: "向量服务返回 HTTP 错误",
      MEMORY_EMBEDDING_UNAVAILABLE: "向量服务连接失败或超时",
      MEMORY_EMBEDDING_EMPTY: "向量服务返回空响应",
      MEMORY_EMBEDDING_TOO_LARGE: "向量服务响应过大",
      MEMORY_EMBEDDING_INPUT_INVALID: "向量输入不符合要求",
      MEMORY_EMBEDDING_INVALID_OUTPUT: "向量格式或维度不符合要求",
      MEMORY_EMBEDDING_INVALID_ORDER: "向量返回顺序不符合要求",
    };
    const status = failure.httpStatus;
    return `${stage}：${messages[String(failure.errorCode)] ?? "向量服务不可用或返回异常"}${Number.isInteger(status) && typeof status === "number" && status >= 100 && status <= 599 ? `（HTTP ${status}）` : ""}`;
  }
  if (category === "database-error") {
    const code = failure.errorCode;
    return `${stage}：数据库错误${typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code) ? `（${code}）` : ""}`;
  }
  if (category === "query-error") return `${stage}：查询条件或来源不可用`;
  if (category === "timeout") return `${stage}：超时`;
  return `${stage}：内部错误`;
}

export function memoryToolLabel(
  toolName: string,
  details: Record<string, unknown> | null,
): string | null {
  if (
    ![
      "search_chat_history",
      "query_chat_messages",
      "count_chat_messages",
      "get_chat_message_extrema",
      "read_chat_excerpt",
    ].includes(toolName) ||
    details?.kind !== "memory" ||
    details.version !== 1
  )
    return null;
  const failure = failureLabel(details.failure);
  if (failure) return failure;
  const fallback = failureLabel(details.embeddingFallback);
  const keyword = failureLabel(details.keywordFailure);
  if (details.status === "unavailable") {
    if (fallback || keyword)
      return ["历史检索不可用", fallback, keyword].filter(Boolean).join(" · ");
    if (details.reason === "source-unavailable")
      return "聊天权限或来源原文不可用";
    if (details.reason === "tool-output") return "工具结果超过剩余输出额度";
    return "历史检索不可用";
  }
  if (toolName !== "search_chat_history") return null;
  const mode =
    details.mode === "hybrid"
      ? keyword
        ? "向量检索（关键词检索失败）"
        : "关键词 + 向量混合检索"
      : details.mode === "keyword-only"
        ? "仅关键词检索"
        : "历史搜索";
  return [
    mode,
    fallback ? `向量检索已降级：${fallback}` : null,
    details.status === "partial" ? "索引覆盖不完整" : null,
    details.status === "no-results" ? "未找到匹配结果" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
