# BlueBubbles 集成说明

## 1. 集成边界

BubblePilot 通过 BlueBubbles 的 Webhook 接收事件，通过 BlueBubbles REST API 发送回复。BlueBubbles 的供应商字段、认证方式和网络错误被封装在 `BlueBubblesAdapter` 中，业务模块只依赖内部接口。

## 2. 入站 Webhook 流程

```text
HTTP request
  ↓
来源与签名验证
  ↓
提取 provider event id
  ↓
幂等登记
  ↓
转换 MessageEnvelope
  ↓
按监听配置归档和匹配
```

适配器必须保留足够的原始事件摘要用于排障，但默认不把完整敏感 Payload 写入普通日志。

## 3. 规范化映射

至少映射以下信息：

- 外部事件标识和事件类型；
- 聊天或群聊标识、类型和显示名称；
- 消息标识、发送者标识、发送时间和文本；
- 附件类型、大小、外部标识等元数据；
- 供应商重试或重放信息；
- 原始 Payload 哈希和适配器版本。

BlueBubbles 新增字段时，优先扩展适配器映射和内部 Schema，不让业务节点直接读取供应商原始 JSON。

## 4. 出站回复

回复命令至少包含：

```text
chatId
text
replyToMessageId (optional)
idempotencyKey
correlationId
```

适配器应区分：请求已确认、请求超时、明确失败、限流和未知结果。未知结果不能直接再次发送，必须先通过幂等键或供应商查询确认状态。

## 5. 重试和幂等

- Webhook 重复投递不能重复归档或启动重复执行。
- 回复发送使用 `executionId + replyNodeId` 作为内部幂等键。
- 网络超时采用有限次数重试和指数退避。
- 供应商返回限流时遵守 `Retry-After` 或适配器定义的退避策略。
- 适配器重试不应绕过工作流执行记录。

## 6. 网络与安全要求

- BlueBubbles Server URL 和访问令牌只从 Secret 或环境变量读取。
- Webhook 入口必须有来源验证、请求大小限制和超时。
- 生产环境优先通过反向代理或私有网络暴露 Webhook，不直接暴露数据库。
- 日志中对 URL、令牌、手机号、联系人和消息正文脱敏。
- 连接健康状态可在管理页面查看，但不显示令牌。

## 7. 兼容性测试

适配器测试至少覆盖：

- 一对一消息；
- 群聊消息；
- 重复 Webhook；
- 缺少可选字段；
- 非文本或带附件消息；
- 发送成功、超时、限流和明确失败；
- 供应商事件版本变化时的拒绝或降级行为。
