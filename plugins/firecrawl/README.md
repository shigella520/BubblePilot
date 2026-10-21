# BubblePilot Firecrawl 适配包

本包由 BubblePilot 独立维护，按本仓库 MIT 许可发布。它是依据官方远程 MCP 接口编写的声明式适配包，不是 Firecrawl 官方 Codex 插件的原样分发，也不复制其 CLI Skill 或脚本。

上游依据（2026-10-21 核对）：

- [Firecrawl MCP 官方说明](https://github.com/firecrawl/firecrawl-mcp-server#hosted-mcp-keyless-free-tier)
- [托管 MCP 配置文档](https://docs.firecrawl.dev/mcp-server)
- [官方 Codex 插件](https://github.com/firecrawl/firecrawl-codex-plugin)：当前依赖 CLI，不能直接用于 BubblePilot 的声明式运行环境。

包内只有清单、HTTP MCP 配置和按需读取 Skill，不要求安装本地工具。连接端点为 `https://mcp.firecrawl.dev/v2/mcp`，使用管理员表单配置的 Bearer Token。`${FIRECRAWL_API_KEY}` 仅声明凭据绑定，应用不会读取宿主同名环境变量；在表单中填写原始 Token，不加 `Bearer ` 前缀，不修改包文件。

## 导入和授权

安装步骤、凭据保管及验收要求以[部署与运维](../../doc/部署与运维.md#firecrawl-独立适配包)为准。

当前推荐单包 ZIP，不能上传整个 BubblePilot 仓库。Git 导入目前在选择子目录前限制整个仓库，因此不承诺本仓库 Git 地址可直接导入。单包打包方式（从仓库根目录运行）：

```bash
(cd plugins/firecrawl && zip -r /tmp/bubblepilot-firecrawl-1.0.0.zip plugin.json mcp.json README.md skills)
```

ZIP 根目录直接包含 `plugin.json`、`mcp.json` 和 `skills/`。README 的仓库相对文档链接仅用于源码阅读，不是运行依赖。

首次只批准 `firecrawl_scrape`。其他工具即便被服务端发现也不要直接全选批准。当前包不硬编码工具 Schema；连接测试发现的定义必须经过兼容性校验和管理员批准。远端工具变化需重新复核。

本地包解析与 ZIP 导入通过不代表真实服务验收完成。未配置凭据前，不进行真实 MCP 握手、抓取或模型调用。最终还需验证工具发现、额度失败反馈，以及搜索 → 按需读取 → 引用回答的执行轨迹。
