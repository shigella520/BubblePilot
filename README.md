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
  面向 BlueBubbles 的自托管消息监听、内容归档、Bot 编排与 AI 交互平台。
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
  <a href="https://www.postgresql.org/"><img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 16" /></a>
</p>

## 项目状态

BubblePilot 已进入编码阶段。M1 消息接入与归档闭环现已可运行：支持 BlueBubbles `new-message` Webhook、监听范围过滤、PostgreSQL 幂等归档、健康检查和受 Token 保护的最小查询 API。下一阶段是事件匹配与基础动作。

## 核心能力

- 监听指定的一对一聊天和群聊消息。
- 按聊天范围独立保存并搜索消息内容。
- 使用关键词、正则、发送者和消息类型匹配 Bot 事件。
- 通过可配置工作流编排条件、变量、AI 和回复节点。
- 管理多个 OpenAI 兼容 AI Provider，并按策略执行 Retry、Fallback 和自动降级。
- 通过 Web 登录和敏感操作二次验证保护聊天数据。
- 使用 Docker Compose 自托管部署。

## 架构概览

BubblePilot 将消息接入、归档、事件匹配、工作流编排和外部服务适配拆成清晰的模块。首期采用模块化单体和进程内队列；节点、适配器和执行器均通过稳定合同扩展，为未来独立 Worker 或外部消息队列保留边界。

![BubblePilot 总体架构](doc/architecture-overview.svg)

架构重点是：BlueBubbles 只负责消息网关，应用数据库保存 BubblePilot 的工作流、执行记录、归档元数据和审计事实；节点通过注册表扩展，编排器不绑定具体业务动作。

## 消息与工作流流程

![BubblePilot 消息到回复流程](doc/message-workflow-flow.svg)

同一外部事件以稳定幂等键处理，消息先标准化和按范围归档，再匹配触发器并锁定工作流版本。AI、条件和回复节点的执行状态都可以追踪、重试或进入人工处理。

## 快速开始

需要 Docker 与 Docker Compose。复制配置并替换所有 `CHANGE_ME`，尤其是数据库密码、API Token 和 Webhook Secret；再把需要归档的 BlueBubbles Chat GUID 写入 `MONITORED_CHAT_IDS`：

```bash
cp .env.example .env
docker compose config
docker compose up -d --build
curl --fail http://127.0.0.1:8080/health/ready
```

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

| 想了解什么 | 阅读 |
| --- | --- |
| 产品目标、范围和验收标准 | [目标需求](doc/目标需求.md) |
| 典型用户交互、异常路径和验收故事 | [典型用户交互故事](doc/典型用户交互故事.md) |
| 阶段目标和非目标 | [产品路线图](doc/产品路线图.md) |
| 当前技术栈、选型理由和重评条件 | [技术选型](doc/技术选型.md) |
| 模块边界和演进方式 | [概要设计](doc/概要设计.md) |
| 仓库目录和依赖方向 | [仓库目录规划](doc/仓库目录规划.md) |
| 实体、状态和幂等规则 | [数据模型与生命周期](doc/数据模型与生命周期.md) |
| 触发器、节点和执行策略 | [事件与工作流设计](doc/事件与工作流设计.md) |
| BlueBubbles 接入和回复 | [BlueBubbles 集成说明](doc/BlueBubbles集成说明.md) |
| API、Webhook 和环境变量 | [接口与配置契约](doc/接口与配置契约.md) |
| 本地开发和测试 | [开发指南](doc/开发指南.md) |
| 分支、Commit 和 PR | [代码管理规范](doc/代码管理规范.md) |
| 中文文档和翻译规则 | [文档规范](doc/文档规范.md) |
| 安全、备份、升级和发布 | [安全与数据隐私](doc/安全与数据隐私.md) · [部署与运维](doc/部署与运维.md) · [版本与发布规范](doc/版本与发布规范.md) |

## 许可证

BubblePilot 使用 [MIT License](LICENSE) 开源。

## 友情链接

<p align="center">
  <a href="https://linux.do" target="_blank">
    <img src="https://img.shields.io/badge/LINUX-DO-FFB003?style=for-the-badge&logo=linux&logoColor=white" alt="LINUX DO" />
  </a>
</p>
