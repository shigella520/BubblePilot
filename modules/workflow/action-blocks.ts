export type ActionBlockCategory =
  "control" | "data" | "context" | "ai" | "message" | "observe";
export type ActionValueType =
  "string" | "number" | "boolean" | "json" | "messages" | "delivery";

export interface ActionPortDefinition {
  name: string;
  label: string;
  type: ActionValueType;
  required?: boolean;
  description: string;
}

export interface ActionConfigDefinition {
  name: string;
  label: string;
  type: "text" | "number" | "boolean" | "select" | "select-array" | "json";
  required?: boolean;
  options?: readonly { value: string; label: string }[];
  emptyLabel?: string;
  description: string;
}

export interface ActionBranchDefinition {
  name: string;
  label: string;
  description: string;
}

export interface ActionBlockDefinition {
  type: string;
  version: number;
  name: string;
  description: string;
  category: ActionBlockCategory;
  inputs: readonly ActionPortDefinition[];
  outputs: readonly ActionPortDefinition[];
  config: readonly ActionConfigDefinition[];
  branches?: readonly ActionBranchDefinition[];
}

const noInputs: readonly ActionPortDefinition[] = [];

export const actionBlockDefinitions: readonly ActionBlockDefinition[] = [
  {
    type: "message-trigger",
    version: 1,
    name: "收到消息",
    description: "当 BlueBubbles 收到符合条件的消息时启动工作流。",
    category: "message",
    inputs: [],
    outputs: [],
    config: [
      {
        name: "provider",
        label: "消息 Provider",
        type: "text",
        description: "留空使用默认消息 Provider。",
      },
      {
        name: "chatIds",
        label: "聊天范围",
        type: "select-array",
        emptyLabel: "全部聊天",
        description: "指定聊天，留空表示全部聊天。",
      },
      {
        name: "includeFromMe",
        label: "包含自己消息",
        type: "boolean",
        description: "是否接收自己发送的消息。",
      },
      {
        name: "senderIds",
        label: "发送者范围",
        type: "json",
        description: "指定发送者，留空表示全部发送者。",
      },
      {
        name: "contentTypes",
        label: "内容类型",
        type: "select-array",
        emptyLabel: "全部类型",
        options: [
          { value: "text", label: "文本" },
          { value: "attachment", label: "附件" },
          { value: "mixed", label: "混合" },
        ],
        description: "指定消息内容类型，留空表示全部类型。",
      },
      {
        name: "enabled",
        label: "启用触发器",
        type: "boolean",
        description: "启用工作流后是否接收匹配消息。",
      },
      {
        name: "textValue",
        label: "消息匹配内容",
        type: "text",
        description: "留空表示不限制消息文本。",
      },
      {
        name: "textKind",
        label: "匹配方式",
        type: "select",
        options: [
          { value: "prefix", label: "前缀" },
          { value: "keyword", label: "包含关键词" },
          { value: "regex", label: "正则表达式" },
        ],
        description: "消息文本匹配方式。",
      },
    ],
  },
  {
    type: "condition",
    version: 1,
    name: "条件判断",
    description: "根据当前消息字段判断并选择 true 或 false 分支。",
    category: "control",
    inputs: [],
    outputs: [],
    config: [
      {
        name: "field",
        label: "字段",
        type: "select",
        required: true,
        description: "事件字段。",
      },
      {
        name: "operator",
        label: "运算符",
        type: "select",
        required: true,
        description: "匹配方式。",
      },
      {
        name: "value",
        label: "比较值",
        type: "text",
        description: "除 exists 外的比较值。",
      },
    ],
    branches: [
      { name: "onTrue", label: "满足条件", description: "条件成立时执行。" },
      {
        name: "onFalse",
        label: "不满足条件",
        description: "条件不成立时执行。",
      },
    ],
  },
  {
    type: "set-variable",
    version: 1,
    name: "设置变量",
    description: "将输入值保存到 Context 变量。",
    category: "data",
    inputs: [
      {
        name: "value",
        label: "值",
        type: "string",
        required: true,
        description: "要保存的值。",
      },
    ],
    outputs: [
      {
        name: "value",
        label: "变量值",
        type: "string",
        description: "保存后的变量值。",
      },
    ],
    config: [
      {
        name: "name",
        label: "变量名",
        type: "text",
        required: true,
        description: "下游动作引用的变量名。",
      },
    ],
  },
  {
    type: "text-template",
    version: 1,
    name: "文本模板",
    description: "组合固定文本和多个 Context 输入。",
    category: "data",
    inputs: [
      {
        name: "values",
        label: "输入值",
        type: "string",
        description: "可连接多个文本输入。",
      },
    ],
    outputs: [
      {
        name: "text",
        label: "文本",
        type: "string",
        description: "组合后的文本。",
      },
    ],
    config: [
      {
        name: "template",
        label: "模板",
        type: "text",
        required: true,
        description: "可插入已连接的输入 Token。",
      },
    ],
  },
  {
    type: "json-parse",
    version: 1,
    name: "JSON 解析",
    description: "将文本解析成结构化 JSON。",
    category: "data",
    inputs: [
      {
        name: "text",
        label: "文本",
        type: "string",
        required: true,
        description: "待解析文本。",
      },
    ],
    outputs: [
      {
        name: "json",
        label: "JSON",
        type: "json",
        description: "解析后的结构化数据。",
      },
    ],
    config: [],
  },
  {
    type: "json-get",
    version: 1,
    name: "JSON 字段提取",
    description: "从 JSON 输出中读取指定字段。",
    category: "data",
    inputs: [
      {
        name: "json",
        label: "JSON",
        type: "json",
        required: true,
        description: "上游 JSON。",
      },
    ],
    outputs: [
      {
        name: "value",
        label: "字段值",
        type: "string",
        description: "提取后的字段。",
      },
    ],
    config: [
      {
        name: "path",
        label: "字段路径",
        type: "text",
        required: true,
        description: "例如 reply.text。",
      },
    ],
  },
  {
    type: "load-context",
    version: 1,
    name: "加载聊天上下文",
    description: "读取当前聊天最近的归档消息。",
    category: "context",
    inputs: noInputs,
    outputs: [
      {
        name: "messages",
        label: "消息列表",
        type: "messages",
        description: "最近聊天消息。",
      },
      {
        name: "count",
        label: "消息数量",
        type: "number",
        description: "实际加载数量。",
      },
    ],
    config: [
      {
        name: "messageLimit",
        label: "消息条数",
        type: "number",
        required: true,
        description: "1 到 50 条。",
      },
      {
        name: "characterLimit",
        label: "字符上限",
        type: "number",
        required: true,
        description: "上下文字符上限。",
      },
      {
        name: "includeFromMe",
        label: "包含自己消息",
        type: "boolean",
        description: "是否包含机器人发送的消息。",
      },
    ],
  },
  {
    type: "ai-chat",
    version: 1,
    name: "AI 对话",
    description: "使用 Provider Route 调用 AI。",
    category: "ai",
    inputs: [
      {
        name: "messages",
        label: "聊天上下文",
        type: "messages",
        description: "可连接加载上下文输出。",
      },
      {
        name: "prompt",
        label: "提示词",
        type: "string",
        required: true,
        description: "用户提示词。",
      },
    ],
    outputs: [
      {
        name: "text",
        label: "文本输出",
        type: "string",
        description: "AI 文本回复。",
      },
      {
        name: "json",
        label: "JSON 输出",
        type: "json",
        description: "JSON 模式下的结构化输出。",
      },
    ],
    config: [
      {
        name: "providerRouteId",
        label: "Provider 路由",
        type: "select",
        required: true,
        description: "要使用的 AI 路由。",
      },
      {
        name: "systemPrompt",
        label: "System Prompt",
        type: "text",
        description: "受保护的系统提示词。",
      },
      {
        name: "promptTemplate",
        label: "提示词",
        type: "text",
        required: true,
        description: "发送给 AI 的任务提示词。",
      },
      {
        name: "outputFormat",
        label: "输出格式",
        type: "select",
        options: [
          { value: "text", label: "文本" },
          { value: "json", label: "JSON" },
        ],
        description: "文本或 JSON。",
      },
    ],
    branches: [
      { name: "onSuccess", label: "成功", description: "AI 调用成功。" },
      { name: "onFailure", label: "失败", description: "AI 调用失败。" },
    ],
  },
  {
    type: "reply",
    version: 1,
    name: "发送回复",
    description: "向当前聊天发送文本消息。",
    category: "message",
    inputs: [
      {
        name: "text",
        label: "消息文本",
        type: "string",
        required: true,
        description: "要发送的文本。",
      },
    ],
    outputs: [
      {
        name: "delivery",
        label: "投递结果",
        type: "delivery",
        description: "发送状态和 Provider Message ID。",
      },
    ],
    config: [
      {
        name: "replyToSourceMessage",
        label: "回复原消息",
        type: "boolean",
        description: "是否设置原消息引用。",
      },
    ],
    branches: [
      { name: "onSuccess", label: "成功", description: "发送成功。" },
      { name: "onFailure", label: "失败", description: "发送失败。" },
    ],
  },
  {
    type: "log",
    version: 1,
    name: "日志记录",
    description: "记录脱敏执行摘要。",
    category: "observe",
    inputs: [
      {
        name: "message",
        label: "日志内容",
        type: "string",
        description: "日志摘要。",
      },
    ],
    outputs: [],
    config: [
      {
        name: "message",
        label: "日志内容",
        type: "text",
        required: true,
        description: "日志消息。",
      },
    ],
  },
  {
    type: "end",
    version: 1,
    name: "结束",
    description: "结束工作流。",
    category: "control",
    inputs: [],
    outputs: [],
    config: [
      {
        name: "result",
        label: "结果",
        type: "select",
        description: "成功或跳过。",
      },
    ],
  },
];

export function listActionBlockDefinitions(): readonly ActionBlockDefinition[] {
  return actionBlockDefinitions;
}
