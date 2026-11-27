/**
 * One place that turns backend enums into Chinese labels and semantic tones,
 * so the same state reads and looks the same on every page.
 */
export type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";
export interface StatusLabel {
  label: string;
  tone: StatusTone;
}

const domains = {
  execution: {
    created: { label: "已创建", tone: "neutral" },
    running: { label: "运行中", tone: "info" },
    retrying: { label: "重试中", tone: "warning" },
    succeeded: { label: "成功", tone: "success" },
    skipped: { label: "已跳过", tone: "neutral" },
    failed: { label: "失败", tone: "danger" },
    "dead-lettered": { label: "重试耗尽", tone: "danger" },
    closed: { label: "已关闭", tone: "neutral" },
  },
  workflow: {
    draft: { label: "草稿", tone: "neutral" },
    active: { label: "已启用", tone: "success" },
    inactive: { label: "已停用", tone: "neutral" },
  },
  memoryJob: {
    queued: { label: "排队中", tone: "neutral" },
    running: { label: "处理中", tone: "info" },
    paused: { label: "已暂停", tone: "warning" },
    succeeded: { label: "已完成", tone: "success" },
    failed: { label: "失败", tone: "danger" },
    cancelled: { label: "已取消", tone: "neutral" },
    superseded: { label: "已被替代", tone: "neutral" },
  },
  dataExport: {
    "awaiting-confirmation": { label: "待确认", tone: "warning" },
    ready: { label: "可下载", tone: "success" },
    revoked: { label: "已撤销", tone: "neutral" },
    expired: { label: "已过期", tone: "neutral" },
  },
  auditOutcome: {
    succeeded: { label: "成功", tone: "success" },
    failed: { label: "失败", tone: "danger" },
    denied: { label: "已拒绝", tone: "warning" },
  },
  operations: {
    healthy: { label: "运行正常", tone: "success" },
    attention: { label: "需关注", tone: "warning" },
    critical: { label: "严重", tone: "danger" },
  },
  health: {
    healthy: { label: "正常", tone: "success" },
    degraded: { label: "降级", tone: "warning" },
    "half-open": { label: "试探恢复", tone: "warning" },
    open: { label: "熔断", tone: "danger" },
    unknown: { label: "未知", tone: "neutral" },
  },
} satisfies Record<string, Record<string, StatusLabel>>;

export type StatusDomain = keyof typeof domains;

/** Unknown values stay visible as-is with a neutral tone. */
export function statusLabel(
  domain: StatusDomain,
  status: string | null | undefined,
): StatusLabel {
  const value = status ?? "";
  const known = (domains[domain] as Record<string, StatusLabel>)[value];
  return known ?? { label: value || "—", tone: "neutral" };
}

/** Plain labels for non-status enums shown in tables and cards. */
const plainLabels = {
  ingestion: {
    accepted: "已接收",
    ignored: "已忽略",
    completed: "已处理",
    failed: "处理失败",
  },
  eventType: {
    "new-message": "新消息",
    "updated-message": "消息修订",
    "unsupported-event": "不支持的事件",
  },
  apiKind: {
    "chat-completions": "Chat Completions",
    responses: "Responses",
  },
  reasoningEffort: {
    default: "默认",
    none: "关闭",
    minimal: "最低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
  },
  operationsAlert: {
    DEAD_LETTERED_EXECUTIONS: "有重试耗尽的执行",
    DEGRADED_AI_PROVIDERS: "有降级的 AI Provider",
    MESSAGE_RETENTION_BACKLOG: "消息清理积压",
    MESSAGE_RETENTION_FAILED: "消息清理失败",
    STALE_RETRYING_EXECUTIONS: "有长时间重试中的执行",
    UNKNOWN_OUTBOUND_DELIVERIES: "有发送结果未知的消息",
    WORKFLOW_QUEUE_SATURATED: "工作流队列已满",
  },
  actorType: {
    anonymous: "匿名",
    session: "管理会话",
    "api-token": "API Token",
    system: "系统",
  },
  auditTarget: {
    "ai-provider": "AI Provider",
    "ai-route": "AI 路由",
    audit: "审计",
    chat: "聊天",
    "data-export": "数据导出",
    execution: "执行",
    "memory-job": "索引任务",
    "memory-source": "检索来源",
    memory: "长期检索",
    message: "消息",
    "scheduled-task": "定时任务",
    settings: "设置",
    trigger: "触发器",
    "workflow-execution": "工作流执行",
    workflow: "工作流",
  },
  nodeType: {
    "message-trigger": "收到消息",
    condition: "条件判断",
    "render-text": "渲染文本",
    "load-context": "加载聊天上下文",
    "ai-chat": "AI 对话",
    reply: "发送回复",
    log: "日志记录",
    end: "结束",
  },
  chatType: {
    group: "群聊",
    direct: "私聊",
    unknown: "未知",
  },
  exportType: {
    messages: "消息",
    executions: "执行记录",
  },
  mediaSource: {
    attachment: "附件",
    "link-preview": "链接预览",
  },
  contentType: {
    text: "文字",
    attachment: "附件",
    mixed: "文字与附件",
    unknown: "未知内容",
  },
} satisfies Record<string, Record<string, string>>;

export type LabelDomain = keyof typeof plainLabels;

/** Chinese label for an enum value; unknown values are shown unchanged. */
export function enumLabel(
  domain: LabelDomain,
  value: string | null | undefined,
): string {
  if (!value) return "—";
  return (plainLabels[domain] as Record<string, string>)[value] ?? value;
}

/** Words used in audit action ids such as "ai.provider.create". */
const auditWords: Record<string, string> = {
  ai: "AI",
  provider: "Provider",
  route: "路由",
  workflow: "工作流",
  "scheduled-task": "定时任务",
  settings: "设置",
  memory: "长期检索",
  trigger: "触发器",
  export: "导出",
  data: "数据",
  execution: "执行",
  context: "上下文",
  chat: "聊天",
  message: "消息",
  messages: "消息",
  idle: "空闲交流",
  participants: "成员映射",
  auth: "登录",
  search: "搜索",
  "web-search": "联网搜索",
  meme: "表情包",
  job: "任务",
  integration: "集成",
  bluebubbles: "BlueBubbles",
  history: "历史",
  event: "事件",
  events: "事件",
  delivery: "投递",
  content: "内容",
  source: "来源",
  sensitive: "敏感操作授权",
  version: "版本",
  "bot-identity": "角色身份",
  "bot-attribution": "角色归属",
  "image-input": "图片输入",
  "generated-image": "生成图片",
  network: "网络",
  monitoring: "监听",
  index: "索引",
  attachments: "附件",
  "ai-response": "模型响应",
  "ai-request": "模型请求",
  agent: "Agent",
  audit: "审计",
  text: "文本",
  html: "HTML",
  health: "健康状态",
  action: "动作",
  create: "创建",
  update: "更新",
  delete: "删除",
  view: "查看",
  read: "读取",
  test: "测试",
  publish: "发布",
  enable: "启用",
  enabled: "启停",
  retry: "重试",
  close: "关闭",
  "bulk-close": "批量关闭",
  cancel: "取消",
  skip: "跳过",
  pause: "暂停",
  resume: "恢复",
  reset: "重置",
  reorder: "排序",
  rebuild: "重建",
  probe: "探测",
  preview: "预览",
  verify: "验证",
  login: "登录",
  logout: "退出",
  import: "导入",
  download: "下载",
  backfill: "回填",
};
/** "ai.provider.create" → "AI Provider · 创建"; unknown words stay as-is. */
export function auditActionLabel(action: string): string {
  const words = action.split(".").map((word) => auditWords[word] ?? word);
  if (words.length < 2) return words.join("");
  const verb = words.pop();
  return `${words.join(" ")} · ${verb}`;
}
