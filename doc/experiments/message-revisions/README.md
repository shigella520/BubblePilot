# 消息修订与引用：第一阶段可行性调研

日期：2026-11-11。关联[迭代需求](../../迭代需求-聊天消息修订与引用.md)。本阶段只检查代码和运行隔离实验，不修改业务代码、数据库、Webhook 订阅或 NAS。

## 结论

**整体有实现路径，但不能仅凭普通 Webhook 完整实现之前设想的字段处理。** 建议采用“Webhook 通知 + 对已授权、已归档目标的受控详情查询”。编辑和消息级引用可以进入开发；全部／部分撤回识别及引用部分定位必须保留字段验证关卡。部分内容无法可靠定位时使用需求规定的待确认行为，不能猜测数组下标，也不能把模型存在撤回字段当成目标环境已验证。

本报告完成的是源码与序列化层预研，不是 NAS 端到端验收。未连接生产网关、未抓取真实聊天、未调用真实模型，未运行迁移或 PostgreSQL 测试。

## 1. 固定版本与证据

- BubblePilot 检查基线：`7baf8da93c92e9cfc1c72932e37b4ef4c5edc09f`，另有本轮未提交的需求文档。
- BlueBubbles Server：`76d2b2e786c04d7516de089f31be978a68da8083`，从 GitHub API 读取固定提交的源码。
- 本地实验：[serializer-probe.mjs](serializer-probe.mjs)，执行上游原始 `MessageSerializer` 与默认配置；模拟网关依赖、聊天／附件序列化和 macOS 版本条件，使用虚构消息。
- 实验通过 15 项断言，未执行上游服务启动、iMessage 数据库解析或 REST 网络请求。

| 源码                                                                                                                                                                                         | 核对结论                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [server/index.ts](https://github.com/BlueBubblesApp/bluebubbles-server/blob/76d2b2e786c04d7516de089f31be978a68da8083/packages/server/src/server/index.ts)                                    | `handleNewMessage`／`handleUpdatedMessage` 分别发送完整 Socket 数据和通知数据；`emitMessage` 将通知数据送到 Webhook |
| [默认序列化配置](https://github.com/BlueBubblesApp/bluebubbles-server/blob/76d2b2e786c04d7516de089f31be978a68da8083/packages/server/src/server/api/serializers/constants.ts)                 | 默认 `parseAttributedBody=false`、`parseMessageSummary=false`                                                       |
| [MessageSerializer](https://github.com/BlueBubblesApp/bluebubbles-server/blob/76d2b2e786c04d7516de089f31be978a68da8083/packages/server/src/server/api/serializers/MessageSerializer.ts)      | 未要求解析时清空摘要；`isForNotification=true` 时不输出 `threadOriginatorPart`                                      |
| [MessageRouter.find](https://github.com/BlueBubblesApp/bluebubbles-server/blob/76d2b2e786c04d7516de089f31be978a68da8083/packages/server/src/server/api/http/api/v1/routers/messageRouter.ts) | 单条详情支持显式请求 `chats`、`attachments`、`attributedBody`、`messageSummaryInfo`，采用非通知序列化               |
| [Message 模型](https://github.com/BlueBubblesApp/bluebubbles-server/blob/76d2b2e786c04d7516de089f31be978a68da8083/packages/server/src/server/databases/imessage/entity/Message.ts)           | `retractedParts` 来自 `messageSummaryInfo[0]`；结合 `dateEdited` 和剩余 `partCount` 区分部分／全部撤回              |

### 字段可达性

下表针对该固定提交，不自动代表 NAS 所接网关版本。字段“保留”表示序列化路径允许输出，真实值仍取决于源消息和 macOS。

| 字段                                       | 新消息 Webhook     | 更新 Webhook       | 完整 Socket／显式 REST 详情 |
| ------------------------------------------ | ------------------ | ------------------ | --------------------------- |
| `guid`、`text`                             | 保留               | 保留               | 保留                        |
| `chats`                                    | 保留               | 不输出             | 可加载                      |
| `threadOriginatorGuid`                     | 保留               | 保留               | 保留                        |
| `threadOriginatorPart`                     | 不输出             | 不输出             | 保留                        |
| `dateEdited`、`dateRetracted`、`partCount` | Ventura 条件下保留 | Ventura 条件下保留 | Ventura 条件下保留          |
| `messageSummaryInfo`、`attributedBody`     | 清为 `null`        | 清为 `null`        | 显式启用后保留              |

因此需要修正两项实现假设：

1. 不能给更新事件复用要求 `chats` 非空的新消息 Schema；优先用供应商消息 GUID 关联本地归档的聊天和权限。
2. 不能指望从普通 Webhook 直接拿到撤回部分列表或引用部分标识；需要详情补全或明确降级，不能用空正文猜撤回。

## 2. 建议技术路径

1. Webhook 验证后按事件类型分流，修订只走归档分支。已知目标按本地消息确认聊天、监听／保留策略；未知目标不能因为无 `chats` 就绕过权限查询网关正文。
2. 对已归档且允许处理的目标，有内容变化线索时通过现有 BlueBubbles 适配器请求**该条消息当前详情**，显式选择必要字段。编辑／撤回不是每次送达／已读更新都请求；按目标合并重复请求，集中设置超时、体积、并发、重试和待处理数量上限。
3. 引用新消息已有目标 GUID 时先保存关系；需要确定引用部分时可查询**这条已授权新消息本身**的详情。展示目标正文仍只读本地已授权归档，不能借此去网关补拉未归档的引用目标。
4. REST 返回可能已经是下一次编辑后的状态，必须以返回修订时间／规范化哈希处理，不能套用较早 Webhook 时间。保留接收时间与源时间，冲突不按到达顺序盲目覆盖。
5. 摘要字段可能含编辑历史，只提取必要的当前状态和部分标识；不把整份摘要持久化、放入日志或提供给模型，仍不新增完整编辑历史正文库。
6. 查询失败、404 或字段缺失不能直接等同撤回。保留可诊断的待确认状态和有界重试，旧修订不能复活撤回内容。消息正常触发不依赖无限等待补全；尚未补全的引用返回 `unresolved`。

“受控查询当前详情”与“自动补拉历史”需要在需求中明确区分：前者补全已授权对象的状态，后者导入原本不在归档中的消息，仍不在范围内。停止监听后的撤回应只允许收缩内容；无法从通知安全确认的更新暂不扩充正文。

不建议为了获取完整事件而在本轮新增 Socket 长连接、重连和补偿链路；也不建议修改 BlueBubbles 上游。现有 REST 适配边界可容纳详情查询，但目标版本的实际 HTTP 响应仍待实测。

## 3. 仓库内部影响：两项需要明确处理的行为冲突

| 位置                                                                     | 已确认事实                                                                 | 开发要求                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [归档入口](../../../modules/ingestion/ingestion-service.ts)              | 当前入口围绕新消息安排上下文、图片摘要和工作流信封                         | 修订必须独立分流，返回空自动化信封，不复用整个新消息流程                                           |
| [索引触发器](../../../migrations/0046_chat_memory.sql)                   | 正文／附件等变化使片段失效并安排重建                                       | 可复用；增加撤回／修订状态依赖，不能只更新一个状态字段而遗漏触发                                   |
| [记忆仓储](../../../modules/memory/memory-repository.ts)                 | 索引提交会重新核对源消息哈希                                               | 扩展哈希与状态覆盖；旧索引立即不可检索，重建可异步                                                 |
| [链接预览提交](../../../modules/archive/postgres-archive-repository.ts)  | 主要以预览 `pending` 状态控制写入                                          | 编辑后重新变为 `pending` 时旧任务可能撞入；需修订号／源哈希条件                                    |
| [图片摘要提交](../../../modules/ai/postgres-image-summary-repository.ts) | 提交核对任务租约与处理状态，未直接比较消息修订号                           | 修订失效任务并防止旧摘要提交，不仅清空页面正文                                                     |
| [附件会话](../../../modules/attachments/attachment-session.ts)           | 源附件元数据变化时 `check()` 会 `close()`，关闭会话并使插件通道失效        | **以读取时状态为准**；已读取／下载内容可继续使用，尚未读取内容按读取时状态校验，真正撤权仍强制失效 |
| [Agent 收尾](../../../modules/ai/agent-runner.ts)                        | 完成后 `attachments.validate()` 会再次验证已导入文件，异常会使整个结果失败 | 必须区分源内容修订与真正撤权，否则与“不干预已有执行”冲突                                           |
| [聊天查询过滤](../../../modules/memory/chat-query-repository.ts)         | 查询和统计共享过滤条件，已排除保留期清理消息                               | 不可全局排除撤回行导致发送次数变化；区分占位计数与内容命中                                         |
| [上下文加载](../../../modules/workflow/conversation-context-service.ts)  | 固定窗口边界，加载时查询当前正文                                           | 与需求“后续查询见当前态”一致，不需要引入历史正文版本库                                             |

### 已确认的运行原则（2026-11-11 补充）

用户明确：**流程／工具执行时，以读取内容那一刻的状态为准；读到了，就可以用读取时的状态继续处理。** 因此本报告中附件冲突的解决边界以“已读取内容”为准，不以“已导入沙箱”为准：

- 已读取正文、工具结果，或已完整下载到任务暂存区的文件，即使还未返回模型／导入沙箱，仍可继续使用，不因之后原消息编辑／撤回失效。
- 只有文件名、附件引用等元数据不等于读到了文件；首次读取内容按当时状态校验。新发起的归档查询读取当前态，继续读任务内文件则使用已有快照。
- 移除因源内容修订而触发的收尾失败／会话关闭路径；真正的聊天、插件和凭据撤权以及文件完整性校验继续生效。
- 写回共享归档的索引／摘要仍需防止旧内容覆盖新状态，不能把“本次任务可继续使用”解释为可以恢复旧归档。

具体读取边界与回归条件见[需求第 7 节](../../迭代需求-聊天消息修订与引用.md#7-工作流隔离与运行中边界)。该原则已在后续实现中落地并经本地附件、图片与记忆测试验证，真实网关联调仍待执行；见[验收记录](../../验收与演练.md#消息修订与引用本地验收2026-11-11)。

## 4. 验证结果与剩余关卡

| 项目                                   | 本阶段结果                                       |
| -------------------------------------- | ------------------------------------------------ |
| 上游存在编辑、全部／部分撤回、引用模型 | 已由固定提交源码确认                             |
| Webhook 与完整详情字段差异             | 已用原始序列化代码、虚构数据验证，15 项断言通过  |
| REST 支持显式请求详情                  | 路由源码确认，序列化部分验证；未做真实 HTTP 联调 |
| 精确的部分编号与正文／附件关联         | 未实测，不能据当前实验宣称完整可行               |
| NAS 网关版本和 macOS 版本、真实事件    | 未检查；后续使用测试聊天完成，不采集无关生产聊天 |
| 归档、索引与执行隔离改造范围           | 已完成静态代码核对，发现上述附件收尾冲突         |
| PostgreSQL 事务、乱序与后台竞态        | 待实际开发后的独立数据库测试；本阶段没有运行     |
| 两种模型 API 的引用理解                | 需求已定义，尚未实现／测试                       |

进入开发前采用上述详情补全路径，不再以“普通 Webhook 字段齐全”为前提。按需求保留 `unresolved`／内容待确认分支可以推进基础实现；若目标网关无法提供足够的部分信息，暂停部分映射的具体实现并说明限制，不能以推测替代验证。

真实验证矩阵应覆盖：单条纯文本编辑、全部撤回、包含多个部分的消息、附件部分、引用整条和特定部分、更新重复／乱序。若设备无法复现某一场景，明确记录“未复现”，不标为通过。真实修订只在明确的测试聊天中由用户操作；本阶段不发送测试消息或改变聊天内容。

## 5. 本地复现实验

只需仓库已有 Node.js／TypeScript，无需 Docker、PostgreSQL 或供应商账号；下载公开源码时需要网络。只执行两个固定哈希的上游模块，不运行仓库脚本或安装上游依赖。

将固定提交下的 `packages/server/src/server/api/serializers/MessageSerializer.ts` 和 `constants.ts` 分别保存为临时目录中的 `serializer.ts`、`constants.ts`，然后在仓库根目录执行：

```sh
node doc/experiments/message-revisions/serializer-probe.mjs /tmp/bubblepilot-revision-feasibility
```

脚本先核对 SHA-256，再转译和执行序列化模块；来源或内容不同会拒绝运行。`vm` 只用于依赖隔离，不被当作执行不可信代码的安全沙箱。

预期输出：

```text
PASS: 15 assertions on pinned upstream serializer; synthetic data only.
Webhook omits summary/part; updated webhook omits chats.
Socket/REST detail serializer retains explicitly requested fields.
```

这些断言证明字段保留／省略行为，**不证明真实 iMessage 的部分数据结构、NAS 版本兼容性或生产端到端成功**。
