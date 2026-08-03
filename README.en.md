<p align="center">
  <img src="assets/brand/bubblepilot-icon.png" width="128" alt="BubblePilot icon" />
</p>

<h1 align="center">BubblePilot</h1>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <strong>English</strong> ·
  <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <strong>Put your BlueBubbles conversations on autopilot.</strong>
</p>

<p align="center">
  A self-hosted message listener, archive, bot orchestration, and AI interaction platform for BlueBubbles.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License" /></a>
  <a href="doc/目标需求.md">Requirements</a> ·
  <a href="doc/概要设计.md">Architecture</a> ·
  <a href="doc/部署与运维.md">Operations</a>
</p>

## Status

BubblePilot is currently in the architecture and documentation phase. The first implementation will deliver message ingestion, archiving, event matching, workflow execution, AI interaction, and Web administration incrementally.

## Core capabilities

- Listen to selected direct chats and group chats.
- Archive and search messages by configured chat scope.
- Match bot events using chats, senders, keywords, regular expressions, and message types.
- Orchestrate conditions, variables, AI calls, and replies through configurable workflows.
- Connect to OpenAI-compatible AI services.
- Protect chat data with Web login and an additional guard for sensitive operations.
- Deploy privately with Docker Compose.

## Architecture overview

BubblePilot separates message ingestion, archiving, event matching, workflow orchestration, and external service adapters. The first runtime is a modular monolith with an in-process queue. Nodes, adapters, and executors use explicit contracts so independent workers or an external message broker can be introduced later without changing workflow semantics.

![BubblePilot architecture](doc/architecture-overview.svg)

BlueBubbles remains a messaging gateway. The application database is authoritative for workflow definitions, execution records, archive metadata, and audit facts. Nodes are registered extensions; the orchestrator does not embed business-specific actions.

## Message and workflow flow

![BubblePilot message-to-reply flow](doc/message-workflow-flow.svg)

Each external event is processed with a stable idempotency key. The message is normalized and archived by scope before triggers are matched and a workflow version is locked. AI, condition, and reply nodes expose traceable, retryable execution states.

## Getting started

There is no runnable application image yet. Start with:

1. [Requirements](doc/目标需求.md)
2. [Architecture](doc/概要设计.md)
3. [Event and workflow design](doc/事件与工作流设计.md)
4. [BlueBubbles integration](doc/BlueBubbles集成说明.md)

Once the M1 ingestion and archiving slice is implemented, this README and the [deployment guide](doc/部署与运维.md) will include a copy-paste Compose setup.

## Documentation

| Topic | Read |
| --- | --- |
| Product scope and acceptance | [目标需求](doc/目标需求.md) |
| Roadmap and non-goals | [产品路线图](doc/产品路线图.md) |
| Modules and evolution | [概要设计](doc/概要设计.md) |
| Repository layout | [仓库目录规划](doc/仓库目录规划.md) |
| Entities, state, and idempotency | [数据模型与生命周期](doc/数据模型与生命周期.md) |
| Triggers, nodes, and execution | [事件与工作流设计](doc/事件与工作流设计.md) |
| BlueBubbles adapter | [BlueBubbles 集成说明](doc/BlueBubbles集成说明.md) |
| APIs, webhooks, and environment variables | [接口与配置契约](doc/接口与配置契约.md) |
| Development and testing | [开发指南](doc/开发指南.md) |
| Branches, commits, and PRs | [代码管理规范](doc/代码管理规范.md) |
| Documentation language policy | [文档规范](doc/文档规范.md) |
| Security, operations, and releases | [安全与数据隐私](doc/安全与数据隐私.md) · [部署与运维](doc/部署与运维.md) · [版本与发布规范](doc/版本与发布规范.md) |

## License

BubblePilot is released under the [MIT License](LICENSE).

## Friends

<p align="center">
  <a href="https://linux.do" target="_blank">
    <img src="https://img.shields.io/badge/LINUX-DO-FFB003?style=for-the-badge&logo=linux&logoColor=white" alt="LINUX DO" />
  </a>
</p>
