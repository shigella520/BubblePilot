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
  → 对候选链接卡片提取有限元数据并更新 Message
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
| `data.chats[0].chatIdentifier` | `chat.displayName`（一对一兜底） | 一对一私聊没有群名称时，用它作为聊天名称 |
| `data.handle.address` | `message.senderId` | 自己发送时使用内部值 `self` |
| `data.dateCreated` | `message.sentAt` | 毫秒时间戳转换为 UTC ISO 8601 |
| `data.text` | `message.text` | 只在监听范围内保存 |
| `data.isFromMe` | `message.isFromMe` | 生产触发器用于阻止 Bot 回复循环 |
| `data.attachments[]` | `message.attachments[]` | 只保存 GUID、MIME、文件名和字节数 |
| `data.hasPayloadData` | `message.linkPreview.status` | 存在卡片载荷时标记为待解析；正文含 HTTP(S) URL 时也会标记 |

原始 Payload 只计算稳定 SHA-256，不整包保存，也不写入普通日志。机器合同见 `contracts/bluebubbles-webhook.schema.json` 和 `contracts/message-envelope.schema.json`。

## 链接卡片预览

对于新入站、已监听且可能包含链接卡片的消息，BubblePilot 先归档基础消息，再按以下顺序补充预览：

1. 使用消息 GUID 调用 BlueBubbles `GET /api/v1/message/{guid}?with=payloadData`，有限重试后解析 `NSKeyedArchive` 中的 Rich Link 元数据；
2. BlueBubbles 没有可用标题、摘要或站点名，且设置中启用了兜底时，从消息或卡片中取首个 HTTP(S) URL，安全请求公开网页的 Open Graph/Twitter/HTML 元数据；
3. 保存统一的 URL、原始 URL、标题、摘要、站点名、图片/图标是否存在，以及能够解析出的公开卡片主图 URL；不保存原始 `payloadData`。卡片解析阶段不持久化或下载图片二进制。

Open Graph 客户端只允许无凭据的 HTTP/HTTPS 与 80/443 端口，DNS 解析后固定公开地址，阻止本机、私网、链路本地、保留地址和 IPv4 映射 IPv6；每次重定向都会重新校验。响应必须是 HTML，正文最多 1 MiB，重定向最多 3 次。超时、HTTP 状态和稳定错误码只写入有限诊断，不保存网页原文。

解析是 fail-open：失败时记录 `unavailable` 或 `failed`，但消息仍继续匹配和执行工作流。设置页可全局关闭卡片解析、关闭 Open Graph 兜底或调整 OG 单次请求超时。配置只影响新消息，不对历史消息回填。

## AI 原生图片输入

管理员在 AI 页面启用全局原生图片输入后，AI 节点可以读取当前消息的图片附件和链接卡片主图；节点开启“包含已加载聊天上下文”时，还会按时间倒序选取有限历史图片，同一条历史消息优先选取卡片主图再选普通附件。附件通过 BlueBubbles `GET /api/v1/attachment/{guid}/download?original=false` 临时获取；卡片主图复用 Open Graph 客户端的 DNS 固定、私网阻断、重定向复检和大小限制。只接受经文件魔数确认的 JPEG、PNG、GIF 或 WebP。

当部署网络使用 Clash 等 Fake-IP DNS，公开图片域名可能解析到保留的 `198.18.0.0/15`。管理员可以在 AI 页面的图片全局配置中逐个填写可信链接图片精确域名；只有这些域名允许使用该 Fake-IP 地址段。白名单不支持通配符或子域名继承，也不会放开回环、局域网、链路本地、云元数据等其他受限地址，重定向后的每个主机仍会重新校验。

图片仅在节点请求内编码为 Data URL，Agent 多轮和 Provider Fallback 复用同一份内存内容；数据库不保存原图、Base64、附件 GUID或完整卡片图片 URL。下载、校验、能力匹配或诊断写入失败都按文本降级处理，不中断工作流，且模型会收到不得声称已经看过图片的限制提示。

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

发送前，BlueBubbles 适配器会将模型偶尔生成的 Markdown 标记规范化为 iMessage 可读的纯文本：移除粗体、斜体、标题、引用、代码围栏等标记，将项目列表和表格转为普通文本，并把 Markdown 链接保留为“名称：URL”。该转换只作用于最终请求体，不修改工作流变量、AI 原始输出、入站消息或执行记录；普通 URL、数字列表和标识符保持不变。

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
