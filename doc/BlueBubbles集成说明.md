# BlueBubbles 集成说明

## 1. 集成边界

BubblePilot 通过 BlueBubbles Webhook 接收事件，并通过 BlueBubbles REST API 发送回复。供应商字段、认证方式和网络错误封装在 `modules/integrations/bluebubbles/` 中，归档和自动化模块只依赖内部 `MessageEnvelope` 与 `ReplyGateway`。

M1 已实现 `new-message` 入站与归档；M2 已实现 REST 回复适配器、内部发送幂等与结果分类。

## 2. BlueBubbles Webhook 行为

BlueBubbles Server 将事件按以下外层结构 POST 到配置 URL：

```json
{
  "type": "new-message",
  "data": {}
}
```

BlueBubbles 当前不会附加签名或共享密钥请求头，只能配置目标 URL。BubblePilot 因此支持：

```text
https://bubblepilot.example.com/api/v1/webhooks/bluebubbles?token=<BLUEBUBBLES_WEBHOOK_SECRET>
```

应在反向代理中关闭该路径的查询串访问日志，并使用 HTTPS 或私有网络。若调用方支持自定义请求头，优先使用 `X-BubblePilot-Webhook-Secret`，避免密钥出现在 URL。

## 3. 入站流程

```text
HTTP request
  ↓
共享密钥与请求大小校验
  ↓
解析 type / data 并计算 Payload Hash
  ↓
使用 new-message:<message-guid> 登记幂等事件
  ↓
转换 MessageEnvelope
  ↓
按 MONITORED_CHAT_IDS 判断监听范围
  ↓
在同一数据库事务中更新 Chat、Message 和 InboundEvent
```

合法但尚未支持的事件类型进入 `ignored` 状态；无效的 `new-message` 返回 `400 INVALID_WEBHOOK`；认证失败返回 `401 INVALID_WEBHOOK_SECRET`。

## 4. M1 字段映射

| BlueBubbles 字段 | BubblePilot 字段 | 说明 |
| --- | --- | --- |
| `type` + `data.guid` | `eventId` | `new-message:<message-guid>` |
| `data.guid` | `message.providerMessageId` | 消息归档唯一键的一部分 |
| `data.chats[0].guid` | `chat.providerChatId` | 聊天监听匹配键 |
| `data.chats[0].style` | `chat.type` | `43` 为群聊，`45` 为一对一，其他为 `unknown` |
| `data.chats[0].displayName` | `chat.displayName` | 可为空 |
| `data.handle.address` | `message.senderId` | 自己发送时使用内部值 `self` |
| `data.dateCreated` | `message.sentAt` | 毫秒时间戳转换为 UTC ISO 8601 |
| `data.text` | `message.text` | 仅监听范围内落库 |
| `data.isFromMe` | `message.isFromMe` | 默认阻止 Bot 自身消息再次触发 |
| `data.attachments[]` | `message.attachments[]` | 只保存 GUID、MIME、文件名和字节数 |

原始 Payload 只计算稳定 SHA-256，不整包保存，也不写入普通日志。机器合同见 `contracts/bluebubbles-webhook.schema.json` 和 `contracts/message-envelope.schema.json`。

## 5. 出站回复

M2 的回复命令包含：

```text
chatId
text
replyToMessageId (optional)
idempotencyKey
correlationId
```

适配器调用 `POST /api/v1/message/text?password=<token>`，把内部命令映射为 `chatGuid`、`message`、`method`、`tempGuid`，可选回复目标映射为 `selectedMessageGuid` 与 `partIndex`。`BLUEBUBBLES_SEND_METHOD` 可选择 `private-api` 或 `apple-script`。

适配器区分请求已确认、明确失败、限流和未知结果。HTTP `429` 与 `5xx` 属于明确可重试失败；超时或网络异常无法证明请求未生效，因此记录为 `unknown` 并进入人工恢复状态，不直接再次发送。

## 6. 重试和幂等

- 入站事件唯一约束：`provider + external_event_id`。
- 消息唯一约束：`provider + provider_message_id`。
- 事件认领、Chat Upsert、消息写入和最终状态更新位于同一事务。
- 已完成或已忽略事件的重复投递返回 `duplicate`。
- 失败事件保留脱敏错误摘要，并允许下一次同键投递重新认领。
- 回复发送使用 `executionId + replyNodeId` 作为内部幂等键，并把稳定的 `providerTempGuid` 保存在 `outbound_deliveries`。

## 7. 兼容性测试

当前自动化测试覆盖：

- 一对一文本消息；
- 群聊与附件元数据；
- 自己发送的消息；
- 重复 Webhook；
- 监听范围过滤；
- 无效 Payload 与错误共享密钥；
- 未支持事件的可观测忽略；
- PostgreSQL 事务、唯一约束和只读查询。

BlueBubbles 供应商字段变化必须先更新适配器 Fixture 和契约，再调整内部映射，不能让业务模块直接兼容原始 JSON。
