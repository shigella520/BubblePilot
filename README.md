<p align="center">
  <img src="assets/brand/bubblepilot-icon.png" width="128" alt="BubblePilot 图标" />
</p>

<h1 align="center">BubblePilot</h1>

<p align="center">
  <a href="README.en.md">English</a> ·
  <strong>简体中文</strong> ·
  <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <strong>让 BlueBubbles 对话自动运转。</strong>
</p>

<p align="center">
  面向 BlueBubbles 的自托管消息监听、内容归档、Bot 编排与 Agent 联网搜索平台。
</p>

<p align="center">
  <a href="doc/目标需求.md">需求文档</a> ·
  <a href="doc/概要设计.md">架构设计</a> ·
  <a href="doc/部署与运维.md">部署与运维</a>
</p>

<p align="center">
  <a href="https://github.com/shigella520/BubblePilot/actions/workflows/ci.yml"><img src="https://github.com/shigella520/BubblePilot/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5" /></a>
  <a href="https://fastify.dev/"><img src="https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white" alt="Fastify 5" /></a>
  <a href="https://vuejs.org/"><img src="https://img.shields.io/badge/Vue.js-3-42B883?logo=vuedotjs&logoColor=white" alt="Vue.js 3" /></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white" alt="Vite 7" /></a>
  <a href="https://www.postgresql.org/"><img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 16" /></a>
</p>

## 项目状态

BubblePilot 已完成 M0-M4：消息归档、事件匹配、可编排工作流、多 AI Provider、Web 管理、搜索、二次验证和受控导出均已形成闭环。AI 节点现已具备轻量 Agent 联网搜索能力，可按问题自动调用 Provider 托管搜索或自托管 SearXNG。M5 的运行可靠性功能与运维工具已经实现，包括容量保护、失败恢复、诊断和备份校验；当前剩余目标环境的 Compose 备份恢复与升级回滚演练。

## 核心能力

- 监听指定的一对一聊天和群聊消息。
- 按聊天范围独立保存并搜索消息内容。
- 使用关键词、正则、发送者和消息类型匹配 Bot 事件。
- 通过可配置工作流编排条件、变量、AI 和回复节点。
- 管理多个 OpenAI 兼容 AI Provider，并按策略执行 Retry、Fallback 和自动降级。
- 通过轻量 AgentRunner 自动判断实时信息需求，调用 Provider 托管搜索或 SearXNG，并记录完整工具轨迹。
- 通过 Web 登录和敏感操作二次验证保护聊天数据。
- 使用 Docker Compose 自托管部署。

## Agent 联网搜索

用户只需提出“最近有什么新进展？”这类自然问题，不必额外说“请联网搜索”。AI 节点可以按工作流配置选择联网策略：

- `auto`：向模型提供 `web_search` 工具，由模型根据问题决定是否搜索；普通知识问答不会强制联网。
- `required`：至少取得一条可用搜索结果后才允许生成回答，适合必须依赖实时信息的流程。
- `disabled`：完全关闭该节点的联网能力。

BubblePilot 优先使用已探测成功的 Provider 托管搜索；其他 OpenAI 兼容 Provider 可通过 Function Calling 驱动进程内 AgentRunner，再由自托管 SearXNG 执行搜索。搜索结果会被视为不可信外部材料，不会作为系统指令执行；模型轮次、工具次数、超时和结果长度均有硬上限。

回复中的来源可设置为完整、精简或隐藏。无论是否向聊天参与者展示链接，管理端的执行详情都会保留 Provider Attempt、实际搜索参数、规范化结果、引擎故障和工具调用状态，便于定位“为什么搜了、搜到了什么、为什么失败”。详细语义见[事件与工作流设计](doc/事件与工作流设计.md)。

## 架构概览

BubblePilot 将消息接入、归档、事件匹配、工作流编排和外部服务适配拆成清晰的模块。首期采用模块化单体和进程内调度；节点、适配器和执行器均通过稳定合同扩展，为未来独立 Worker 或外部消息队列保留边界。

![BubblePilot 总体架构](doc/architecture-overview.svg)

架构重点是：BlueBubbles 只负责消息网关，应用数据库保存 BubblePilot 的工作流、执行记录、归档元数据和审计事实；节点通过注册表扩展，编排器不绑定具体业务动作。

## 消息与工作流流程

![BubblePilot 消息到回复流程](doc/message-workflow-flow.svg)

同一外部事件以稳定幂等键处理，消息先标准化和按范围归档，再匹配触发器并锁定工作流版本。AI、条件和回复节点的执行状态都可以追踪、重试或进入人工处理。

## 快速开始

需要 Docker 与 Docker Compose。复制配置并替换所有 `CHANGE_ME`，尤其是数据库密码、API Token、Webhook Secret、BlueBubbles Server URL、访问令牌和 `SEARXNG_SECRET`；再把需要归档的 BlueBubbles Chat GUID 写入 `MONITORED_CHAT_IDS`。AI 服务地址、模型和 Key 通过受保护的 Web 管理端配置：

```bash
cp .env.example .env
docker compose config
docker compose up -d --build
curl --fail http://127.0.0.1:8080/health/ready
```

Compose 已包含不对宿主机暴露端口的 SearXNG。联网搜索默认关闭；需要使用时在 `.env` 中生成独立随机密钥并启用总开关：

```dotenv
ENABLE_WEB_SEARCH=true
SEARXNG_SECRET=CHANGE_ME_WITH_AT_LEAST_32_RANDOM_CHARACTERS
```

启动后在“AI Provider”页面分别探测基础连接、Function Calling 和 Provider 托管搜索能力，再把 AI 节点的联网策略设为 `auto` 或 `required`。

在 BlueBubbles Server 中订阅 `New Messages`，Webhook URL 设置为：

```text
https://你的域名/api/v1/webhooks/bluebubbles?token=<BLUEBUBBLES_WEBHOOK_SECRET>
```

生产环境必须使用 HTTPS 或私有网络，并关闭反向代理对该路径查询串的访问日志。完整配置、验证与查询示例见[部署与运维](doc/部署与运维.md)。设计入口：

1. [目标需求](doc/目标需求.md)
2. [概要设计](doc/概要设计.md)
3. [事件与工作流设计](doc/事件与工作流设计.md)
4. [BlueBubbles 集成说明](doc/BlueBubbles集成说明.md)

## 文档导航

| 想了解什么                       | 阅读                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 产品目标、范围和验收标准         | [目标需求](doc/目标需求.md)                                                                                         |
| 典型用户交互、异常路径和验收故事 | [典型用户交互故事](doc/典型用户交互故事.md)                                                                         |
| 阶段目标和非目标                 | [产品路线图](doc/产品路线图.md)                                                                                     |
| 当前开发状态和短周期记录         | [开发进度](doc/开发进度.md)                                                                                         |
| 当前技术栈、选型理由和重评条件   | [技术选型](doc/技术选型.md)                                                                                         |
| 模块边界和演进方式               | [概要设计](doc/概要设计.md)                                                                                         |
| 仓库目录和依赖方向               | [仓库目录规划](doc/仓库目录规划.md)                                                                                 |
| 实体、状态和幂等规则             | [数据模型与生命周期](doc/数据模型与生命周期.md)                                                                     |
| 触发器、节点和执行策略           | [事件与工作流设计](doc/事件与工作流设计.md)                                                                         |
| BlueBubbles 接入和回复           | [BlueBubbles 集成说明](doc/BlueBubbles集成说明.md)                                                                  |
| API、Webhook 和环境变量          | [接口与配置契约](doc/接口与配置契约.md)                                                                             |
| 本地开发和测试                   | [开发指南](doc/开发指南.md)                                                                                         |
| 分支、Commit 和 PR               | [代码管理规范](doc/代码管理规范.md)                                                                                 |
| 中文文档和翻译规则               | [文档规范](doc/文档规范.md)                                                                                         |
| 安全、备份、升级和发布           | [安全与数据隐私](doc/安全与数据隐私.md) · [部署与运维](doc/部署与运维.md) · [版本与发布规范](doc/版本与发布规范.md) |

## 许可证

BubblePilot 使用 [MIT License](LICENSE) 开源。

## 友情链接

<p align="center">
  <a href="https://linux.do" target="_blank">
    <img src="https://img.shields.io/badge/LINUX-DO-FFB003?style=for-the-badge&logo=linux&logoColor=white" alt="LINUX DO" />
  </a>
</p>
