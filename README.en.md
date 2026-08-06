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
  A self-hosted message listener, archive, bot orchestration, and agentic web-search platform for BlueBubbles.
</p>

<p align="center">
  <a href="doc/目标需求.md">Requirements</a> ·
  <a href="doc/概要设计.md">Architecture</a> ·
  <a href="doc/部署与运维.md">Operations</a>
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

## Status

BubblePilot has completed M0-M4: message archiving, event matching, composable workflows, multi-provider AI, Web administration, search, secondary verification, and controlled exports now form an end-to-end flow. AI nodes now include a lightweight agentic web-search path that can use provider-hosted search or a self-hosted SearXNG instance. M5 runtime reliability features and operational tooling are implemented, including capacity protection, failure recovery, diagnostics, and backup verification; Compose backup/restore and upgrade rollback rehearsals still need to be completed in the target environment.

## Core capabilities

- Listen to selected direct chats and group chats.
- Archive and search messages by configured chat scope.
- Match bot events using chats, senders, keywords, regular expressions, and message types.
- Orchestrate conditions, variables, AI calls, and replies through configurable workflows.
- Manage multiple OpenAI-compatible AI providers with bounded retries, fallback, and automatic degradation.
- Let a bounded AgentRunner detect real-time information needs, use provider-hosted search or SearXNG, and retain a complete tool trace.
- Protect chat data with Web login and an additional guard for sensitive operations.
- Deploy privately with Docker Compose.

## Agentic web search

Users can ask a natural question such as “What changed recently?” without explicitly requesting a web search. Each AI node selects one of three policies:

- `auto` exposes the `web_search` tool and lets the model decide whether current information is needed.
- `required` only allows an answer after at least one usable search result has been obtained.
- `disabled` removes web-search access from the node.

BubblePilot prefers provider-hosted search after a successful capability probe. Other OpenAI-compatible providers can use Function Calling to drive the in-process AgentRunner, which searches through a self-hosted SearXNG instance. Search results are treated as untrusted external material rather than system instructions, and model rounds, tool calls, timeouts, and result sizes all have hard limits.

Sources can be shown in full, condensed, or hidden in the chat reply. The execution detail keeps provider attempts, search parameters, normalized results, engine failures, and tool status in every mode so operators can explain why a search ran and what it returned. See [event and workflow design](doc/事件与工作流设计.md) for the exact semantics.

## Architecture overview

BubblePilot separates message ingestion, archiving, event matching, workflow orchestration, and external service adapters. The first runtime is a modular monolith with in-process dispatch. Nodes, adapters, and executors use explicit contracts so independent workers or an external message broker can be introduced later without changing workflow semantics.

![BubblePilot architecture](doc/architecture-overview.svg)

BlueBubbles remains a messaging gateway. The application database is authoritative for workflow definitions, execution records, archive metadata, and audit facts. Nodes are registered extensions; the orchestrator does not embed business-specific actions.

## Message and workflow flow

![BubblePilot message-to-reply flow](doc/message-workflow-flow.svg)

Each external event is processed with a stable idempotency key. The message is normalized and archived by scope before triggers are matched and a workflow version is locked. AI, condition, and reply nodes expose traceable, retryable execution states.

## Getting started

Docker and Docker Compose are required. Copy the environment template, replace every `CHANGE_ME` value—especially the database password, API token, webhook secret, BlueBubbles Server URL, access token, and `SEARXNG_SECRET`—and add the BlueBubbles Chat GUIDs to archive to `MONITORED_CHAT_IDS`. Provider endpoints, models, and keys are configured in the protected Web administration interface:

```bash
cp .env.example .env
docker compose config
docker compose up -d --build
curl --fail http://127.0.0.1:8080/health/ready
```

Compose includes SearXNG without exposing its port to the host. Web search is disabled by default; generate a separate random secret and enable the instance-wide switch when needed:

```dotenv
ENABLE_WEB_SEARCH=true
SEARXNG_SECRET=CHANGE_ME_WITH_AT_LEAST_32_RANDOM_CHARACTERS
```

After startup, use the AI Provider page to probe basic connectivity, Function Calling, and provider-hosted search separately, then set the AI node policy to `auto` or `required`.

Subscribe to `New Messages` in BlueBubbles Server and configure this webhook URL:

```text
https://your-domain.example/api/v1/webhooks/bluebubbles?token=<BLUEBUBBLES_WEBHOOK_SECRET>
```

Production deployments must use HTTPS or a private network and must disable reverse-proxy query-string access logs for this path. See [deployment and operations](doc/部署与运维.md) for complete configuration, verification, and query examples. Design entry points:

1. [Requirements](doc/目标需求.md)
2. [Architecture](doc/概要设计.md)
3. [Event and workflow design](doc/事件与工作流设计.md)
4. [BlueBubbles integration](doc/BlueBubbles集成说明.md)

## Documentation

| Topic                                                       | Read                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Product scope and acceptance                                | [目标需求](doc/目标需求.md)                                                                                         |
| Typical interactions, failure paths, and acceptance stories | [典型用户交互故事](doc/典型用户交互故事.md)                                                                         |
| Roadmap and non-goals                                       | [产品路线图](doc/产品路线图.md)                                                                                     |
| Current implementation status and iteration log             | [开发进度](doc/开发进度.md)                                                                                         |
| Current stack, rationale, and review triggers               | [技术选型](doc/技术选型.md)                                                                                         |
| Modules and evolution                                       | [概要设计](doc/概要设计.md)                                                                                         |
| Repository layout                                           | [仓库目录规划](doc/仓库目录规划.md)                                                                                 |
| Entities, state, and idempotency                            | [数据模型与生命周期](doc/数据模型与生命周期.md)                                                                     |
| Triggers, nodes, and execution                              | [事件与工作流设计](doc/事件与工作流设计.md)                                                                         |
| BlueBubbles adapter                                         | [BlueBubbles 集成说明](doc/BlueBubbles集成说明.md)                                                                  |
| APIs, webhooks, and environment variables                   | [接口与配置契约](doc/接口与配置契约.md)                                                                             |
| Development and testing                                     | [开发指南](doc/开发指南.md)                                                                                         |
| Branches, commits, and PRs                                  | [代码管理规范](doc/代码管理规范.md)                                                                                 |
| Documentation language policy                               | [文档规范](doc/文档规范.md)                                                                                         |
| Security, operations, and releases                          | [安全与数据隐私](doc/安全与数据隐私.md) · [部署与运维](doc/部署与运维.md) · [版本与发布规范](doc/版本与发布规范.md) |

## License

BubblePilot is released under the [MIT License](LICENSE).

## Friends

<p align="center">
  <a href="https://linux.do" target="_blank">
    <img src="https://img.shields.io/badge/LINUX-DO-FFB003?style=for-the-badge&logo=linux&logoColor=white" alt="LINUX DO" />
  </a>
</p>
