# BlueBubbles 集成说明

## 集成边界

BubblePilot 通过 BlueBubbles Webhook 接收事件，通过 BlueBubbles REST API 发送回复。供应商字段、认证和网络错误必须封装在 `modules/integrations/bluebubbles/`；归档和工作流只依赖项目自己的 `MessageEnvelope` 与 `ReplyGateway`。

BlueBubbles 是消息网关，不是 BubblePilot 监听状态、归档、工作流、执行或审计记录的权威来源。

## 连接配置

首次启动必须在 `.env` 提供有效回退配置：

```dotenv
BLUEBUBBLES_SERVER_URL=http://192.0.2.10:1234
BLUEBUBBLES_ACCESS_TOKEN=虚构的-rest-api-password
BLUEBUBBLES_WEBHOOK_SECRET=至少-32-字符的独立随机值
BLUEBUBBLES_SEND_METHOD=private-api
BLUEBUBBLES_REQUEST_TIMEOUT_MS=30000
```

管理员之后可以在“设置”页面完成二次验证，将连接保存到 PostgreSQL 并立即生效。页面不会回显 Access Token 或 Webhook Secret；编辑时 Secret 留空表示保留原值。数据库设置可用时优先于环境变量，环境变量仍作为启动回退。

`BLUEBUBBLES_SEND_METHOD` 支持 `private-api` 和 `apple-script`。优先使用 BlueBubbles 实例实际支持并已验证的发送方式。

## Webhook

BlueBubbles Server 将事件按以下结构 POST：

```json
{
  "type": "new-message",
  "data": {}
}
```

BlueBubbles 不附加自定义签名或共享密钥请求头，因此 Webhook URL 使用查询参数：

```text
https://bubblepilot.example.com/api/v1/webhooks/bluebubbles?token=<BLUEBUBBLES_WEBHOOK_SECRET>
```

在 BlueBubbles Server 中订阅 `New Messages`。生产环境必须使用 HTTPS 或受控私网，并关闭反向代理对该路径查询串的访问日志。支持自定义 Header 的其他调用方可使用 `X-BubblePilot-Webhook-Secret`。

处理顺序：

```text
校验 Secret 和请求大小
  → 解析 type / data 并计算 Payload Hash
  → 使用 new-message:<message-guid> 认领事件
  → 转换带版本的 MessageEnvelope
  → 更新 Chat 并判断监听状态
  → 在事务中保存 Message、InboundEvent 和自动化判定
  → 匹配启用工作流并调度执行
```

合法但未支持的事件进入 `ignored`；无效 `new-message` 返回 `400 INVALID_WEBHOOK`；Secret 错误返回 `401 INVALID_WEBHOOK_SECRET`。请求成功返回 `202`，并提供 `archived`、`ignored` 或 `duplicate` 接入状态及自动化判定。

未监听聊天仍会创建最小 Chat 元数据，便于管理员在 Web 页面发现并启用；其消息正文和附件元数据不会归档。`MONITORED_CHAT_IDS` 只决定尚未发现聊天的初始监听状态，聊天入库后以数据库状态为准。

## 字段映射

| BlueBubbles 字段 | BubblePilot 字段 | 说明 |
| --- | --- | --- |
| `type` + `data.guid` | `eventId` | `new-message:<message-guid>` |
| `data.guid` | `message.providerMessageId` | 供应商消息唯一标识 |
| `data.chats[0].guid` | `chat.providerChatId` | 监听和回复使用的 Chat GUID |
| `data.chats[0].style` | `chat.type` | `43` 为群聊，`45` 为一对一，其他为 `unknown` |
| `data.chats[0].displayName` | `chat.displayName` | 可以为空 |
| `data.handle.address` | `message.senderId` | 自己发送时使用内部值 `self` |
| `data.dateCreated` | `message.sentAt` | 毫秒时间戳转换为 UTC ISO 8601 |
| `data.text` | `message.text` | 只在监听范围内保存 |
| `data.isFromMe` | `message.isFromMe` | 生产触发器用于阻止 Bot 回复循环 |
| `data.attachments[]` | `message.attachments[]` | 只保存 GUID、MIME、文件名和字节数 |

原始 Payload 只计算稳定 SHA-256，不整包保存，也不写入普通日志。机器合同见 `contracts/bluebubbles-webhook.schema.json` 和 `contracts/message-envelope.schema.json`。

## 出站回复

内部回复命令包含：

```text
chatId
text
replyToMessageId (optional)
idempotencyKey
correlationId
```

适配器调用 BlueBubbles `POST /api/v1/message/text?password=<token>`，映射 `chatGuid`、`message`、`method`、稳定 `tempGuid`，可选引用消息映射为 `selectedMessageGuid` 与 `partIndex`。

结果分类：

- `confirmed`：供应商明确确认；
- `failed`：明确未生效的客户端、限流或服务端失败，可按策略处理；
- `unknown`：超时或网络异常，无法证明消息是否已经发送。

`unknown` 不自动重发。运维者必须先确认 BlueBubbles 中的外部事实，再关闭或按安全边界处理执行。

## 幂等与兼容性

- 入站事件唯一键：`provider + externalEventId`；
- 消息唯一键：`provider + providerMessageId`；
- 触发执行 Claim：`eventId + workflowVersionId + triggerId`；
- 回复键：`executionId + replyNodeId`，并保存稳定 `providerTempGuid`。

已完成或忽略事件重投返回 `duplicate`。处于 `evaluation-pending` 的事件允许重投继续调度，但不会重复执行或回复。

供应商字段变化必须先更新虚构 Fixture、Webhook Schema 和适配器测试，再调整内部映射；业务模块不能直接兼容 BlueBubbles 原始 JSON。当前测试覆盖一对一、群聊、附件、自身消息、重复投递、监听过滤、无效 Payload、错误 Secret、未支持事件、REST 回复结果和 PostgreSQL 唯一约束。
