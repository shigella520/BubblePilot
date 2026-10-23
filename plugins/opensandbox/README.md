# OpenSandbox 插件与 MCP 适配服务

这里一起维护声明式插件包、独立 TypeScript 服务和 Compose 配置。只导入 `plugins/opensandbox/plugin`，不要导入包含服务源码的父目录。

## 安装边界

插件 Git 目录地址（代码合入并推送后才可使用）：
`https://github.com/shigella520/BubblePilot/tree/main/plugins/opensandbox/plugin`

服务必须先独立部署。插件导入不会运行 Docker、安装软件或启动服务。安装时将连接地址改为 BubblePilot 可访问的 `/mcp`，明确批准内网目标；认证方式选择 `Bearer Token`，凭据只填写原始 MCP token（不要加 `Bearer ` 前缀，应用会自动添加）。这是适配服务 token，不是 OpenSandbox API key。连接测试只握手、发现工具，不创建沙箱。

管理员审阅并批准四个工具后，再绑定 AI 文本节点。`run_command` 与 `write_file` 有副作用。应用没有新增配置、迁移、角色绑定或自动授权。

## 生命周期和限制

一个 MCP 会话对应一次 AI 运行，首次 `prepare_sandbox` 创建临时沙箱；同一次运行内复用，不跨对话保留。断开 HTTP 流不销毁会话，DELETE 立即撤销使用权限并异步清理。TTL 为绝对上限，不续期。命令取消、超时、结果未知或输出超限后失效，禁止自动重放。

| 配置/限制 | 默认与边界 |
| --- | --- |
| `MAX_CONCURRENT_SANDBOXES` | 1，可配置 1–8；创建中和清理中也占位，满额立即拒绝 |
| `MAX_MCP_SESSIONS` | 64，可配置 1–256；包含只握手未创建沙箱的会话 |
| `SANDBOX_TTL_SECONDS` | 600，范围 60–1800 秒 |
| `SANDBOX_MEMORY_MIB` | 512，范围 128–4096 MiB |
| `SANDBOX_IMAGE` | 必填 Python 3.12 digest；示例固定多架构镜像索引 |
| 创建/命令/文件 | 40 秒 / 默认 20、最大 30 秒 / 10 秒 |
| 命令输出 | stdout + stderr 最多 1 MiB；流式读取，超限停止并使沙箱失效 |
| 文件读写 | 每次最多 64 KiB UTF-8；读取按字节，使用 nextOffset 继续 |
| MCP 请求正文 | 最大 512 KiB；不保存请求正文或普通输出日志 |

工具继续使用 BubblePilot 共享工具次数、时间和文本预算；应用单次 MCP 上限 45 秒、默认累计 90 秒不变。创建耗时包含在其中。大输出优先重定向文件，再分段读取。

仅支持一个适配服务副本。同一实例标识不能用于同时运行的多个副本。每次启动先删除属于 `ADAPTER_INSTANCE_ID` 的遗留沙箱；清理失败不开始接收请求。创建响应丢失时通过独有会话标签追踪，并保留槽位至远端 TTL；删除响应返回后还要核对资源不存在。服务崩溃后的最后防线是 OpenSandbox 自身 TTL。

## Docker Compose

在仓库根目录执行：

```sh
cp plugins/opensandbox/deploy/.env.example plugins/opensandbox/deploy/.env
mkdir -p plugins/opensandbox/deploy/secrets
# 在 secrets/mcp_token 和 secrets/opensandbox_api_key 中分别保存两个不同密钥。
# 文件须允许容器 node 用户只读；目录和文件禁止其他无关账号读取。
docker compose --env-file plugins/opensandbox/deploy/.env -f plugins/opensandbox/deploy/compose.yaml config --quiet
docker compose --env-file plugins/opensandbox/deploy/.env -f plugins/opensandbox/deploy/compose.yaml build
docker compose --env-file plugins/opensandbox/deploy/.env -f plugins/opensandbox/deploy/compose.yaml up -d
```

先在 **OpenSandbox 所在 Docker 主机**拉取 `.env` 指定的 Python 镜像。应用、适配服务、OpenSandbox API 是三个独立地址；默认 MCP 只绑定 loopback，跨容器使用时按实际网络配置连接地址或共享网络。不要把有命令执行权限的服务无认证公开到公网。

OpenSandbox 现有代理环境配置继续负责沙箱联网，例如由管理员在其 `sandbox_env` 中设置 HTTP_PROXY/HTTPS_PROXY。适配服务自身不把这些变量或 API key 注入沙箱。使用 SDK 的 server proxy 访问 execd，不需要向应用暴露动态沙箱端口。NAS 缺少 CPU CFS 时只下发 memory，不使用 SDK 默认 CPU 配额；并发、内存及 TTL 不能代替 CPU/网络隔离。OpenSandbox 服务端须继续配置 no-new-privileges、进程数限制和网络访问边界。

不挂宿主目录或 Docker Socket 给适配服务/沙箱。`/workspace` 文件工具逐级使用目录描述符和 O_NOFOLLOW 拒绝符号链接；这不是 shell 文件系统隔离，命令可以操作整个沙箱。首版不提供文件下载附件、后台任务或持久角色环境。

## 维护、备份和验证

适配服务只保留内存会话，重启会清理旧沙箱。备份部署 `.env` 与 `secrets/`（受保护），和 BubblePilot 插件版本/数据库备份统一放在 `backups/`；不备份临时沙箱。恢复后保持实例标识稳定，先完成遗留资源核对再启用工作流。

```sh
pnpm sandbox:verify
pnpm verify
pnpm security:check
```

文件边界测试使用系统 Python 3 执行虚构临时文件，不安装本机数据库或新 Python。独立 Docker PostgreSQL 集成验证按[开发说明](../../doc/开发与发布.md)执行。

自动化测试使用模拟 OpenSandbox 后端与真实 MCP SDK 客户端，检查隔离、配额、取消、迟到结果、TTL、清理失败、鉴权、路径及输出上限。真实 OpenSandbox 服务与真实模型联合验收另行执行；本次不部署 NAS，不授权生产工作流。此前 NAS 创建速度/代理测试不等同于本适配服务联调通过。
