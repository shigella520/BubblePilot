# 图像生成插件（bubblepilot-image-gen）

独立的 MCP 适配服务：调用 OpenAI Images 兼容接口生成新图片，或基于用户发来的图片进行编辑，并通过 BubblePilot 现有的附件导入与图片导出协议完成“导入 → 编辑 → 准备回复附件”的闭环。设计与 BubblePilot 侧的改造见[迭代需求：独立生图插件与图片编辑](../../doc/迭代需求-独立生图插件与图片编辑.md)。

## 组成

| 目录 | 内容 |
| --- | --- |
| `server/` | Node.js MCP 服务（Streamable HTTP）、会话工作区、二进制通道、上游客户端与额度 |
| `plugin/` | 插件包：`plugin.json`、`mcp.json`、`skills/image-gen/SKILL.md` |
| `deploy/` | `compose.yaml` 与虚构值的 `.env.example` |

## 工具与协议

| 工具 | 说明 |
| --- | --- |
| `generate_image` | `prompt`，可选 `size`（`1024x1024`、`1536x1024`、`1024x1536`、`auto`）和 `quality`（`low`、`medium`、`high`、`auto`）。返回 `/workspace/image-gen/out/<uuid>.png` |
| `edit_image` | `prompt`、`images`（1～4 个本会话路径：导入的附件或之前的输出），可选 `size`、`quality`。返回新的 PNG 路径 |
| `view_image` | 有界静态预览（与 OpenSandbox 相同的元数据与上限），用于发送前自检 |

`experimental` 能力（BubblePilot 按 `anchorTool` 识别为生成器目标）：

```json
{
  "io.bubblepilot/image-export": { "version": 1, "fileBytes": 8388608, "anchorTool": "generate_image", "workspacePrefix": "/workspace/image-gen/" },
  "io.bubblepilot/attachments": {
    "version": 1, "fileBytes": 20971520, "files": 5, "totalBytes": 52428800,
    "anchorTool": "generate_image", "workspacePrefix": "/workspace/image-gen/",
    "mimeTypes": ["image/png", "image/jpeg", "image/webp"]
  }
}
```

- 附件导入与图片导出的端点、票据和错误代码与 OpenSandbox 一致：`/mcp/attachments(/tickets)`、`/mcp/image-exports(/tickets)`；票据绑定 `mcp-session-id`、单次有效、导出 30 秒过期，同时最多 4 张。不提供 `file-export`，只导出 PNG。
- 导入按文件内容识别格式，名单外的内容返回 `attachment_type_unsupported`，不会写入工作区；HEIC 须由 BubblePilot 先转换。
- 工作区只在内存中，按 MCP 会话隔离；会话结束、超时（默认 15 分钟）或删除时立即清空，不持久化用户图片或生成结果。

## 部署（NAS）

1. 在 Dockge 新建栈（例如 `image-gen`），粘贴 `deploy/compose.yaml`，按 `deploy/.env.example` 在栈的 `.env` 中填写实际值：上游地址、上游 Key、随机 Bearer Token（至少 24 个字符）。
2. 群晖不会自动创建绑定目录：先创建栈目录下的 `data/`，并让容器用户（UID 1000）可写，用于保存每日额度计数。
3. 网络：
   - `bubblepilot_mcp`（内部网络）：BubblePilot 通过别名 `image-gen-mcp:8080` 访问。该别名只挂在内部网络上；服务名（`image-gen`）会在所有网络上注册 DNS，不能与别名相同，否则同样接入 macvlan 的 BubblePilot 会解析到不监听的 `.78`；
   - `macvlan_gw11`：只用于经 `.11` 网关访问上游，地址默认 `192.168.31.78`。
4. 监听规则：服务启动时绑定第一个不属于 `LISTEN_EXCLUDE_CIDR`（默认 `192.168.31.0/24`）的 IPv4 地址，即内部网络地址，**不在 macvlan 局域网地址上监听**；找不到合格地址时拒绝启动。健康检查只在容器内 `127.0.0.1:8081/healthz`。上线后应从局域网另一台设备确认 `192.168.31.78:8080` 无法连接。
5. 在 BubblePilot 插件管理导入 `plugin/` 包，`mcp.json` 中的 `${IMAGE_GEN_MCP_TOKEN}` 填写与 `MCP_BEARER_TOKEN` 相同的值（格式为 `Bearer <token>`），发现并批准三个工具。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `IMAGE_API_BASE_URL` | 必填 | OpenAI Images 兼容地址；自动补全 `/v1` |
| `IMAGE_API_KEY` / `IMAGE_API_KEY_FILE` | 必填其一 | 上游 Key，只在本服务内使用 |
| `MCP_BEARER_TOKEN` / `MCP_BEARER_TOKEN_FILE` | 必填其一 | BubblePilot 访问本服务的 Token |
| `IMAGE_MODEL` | `gpt-image-2` | 上游模型名 |
| `IMAGE_DEFAULT_QUALITY` / `IMAGE_MAX_QUALITY` | `medium` / `high` | 未指定质量时的默认档位；模型请求超过上限时按上限执行 |
| `IMAGE_DAILY_LIMIT` | `20` | 每日上游调用上限，按 `IMAGE_QUOTA_TIMEZONE` 的自然日计算 |
| `IMAGE_SESSION_LIMIT` | `4` | 单次运行（MCP 会话）内的调用上限 |
| `IMAGE_TIMEOUT_SECONDS` | `150` | 单次上游请求超时 |
| `IMAGE_EDIT_FIELD` | `auto` | 多图编辑的字段名：单图 `image`，多图重复 `image[]`；可强制为 `image` 或 `image[]` |
| `LISTEN_EXCLUDE_CIDR` | 空 | 禁止绑定的网段，NAS 部署须设为局域网网段 |
| `SESSION_TTL_SECONDS`、`WORKSPACE_MAX_FILES`、`WORKSPACE_MAX_MIB`、`MAX_MCP_SESSIONS` | 900、16、64、8 | 会话工作区上限 |

修改配置后重新部署本栈即可，不需要改动 BubblePilot。

## 费用与重试

- 额度在请求可能已到达上游时计入（包括超时等结果未知的情况）；能证明请求从未发出的连接失败（连接被拒绝、DNS 失败等）不计入，并且只重试这一次。
- 超时、连接中断等结果未知的请求不会自动重放，避免重复计费；工具返回 `upstream_timeout` 或 `upstream_unavailable`，由模型如实说明。
- 上游安全策略拒绝返回 `content_rejected`；技能指引要求模型如实告知，不改写措辞绕过。

## 安全边界

- 上游 Key 只存在于本服务的环境变量或密钥文件；不进入模型、沙箱或 BubblePilot 数据库。
- 日志只记录事件、尺寸、质量、用量与耗时，不记录 prompt、图片内容、Key 或上游原始错误文本。
- 只请求配置的上游地址，禁止跟随重定向；容器只读根文件系统、非 root、丢弃全部 capabilities。
- **轮换上游 Key**：在中转站作废旧 Key、生成新 Key，更新栈 `.env` 后重新部署；开发、调试中出现在聊天或日志里的 Key 都应轮换。

## 开发验证

```sh
pnpm imagegen:verify
docker compose --env-file plugins/image-gen/deploy/.env.example -f plugins/image-gen/deploy/compose.yaml config --quiet
docker build -f plugins/image-gen/server/Dockerfile -t bubblepilot-image-gen-mcp:local .
```

测试使用模拟上游，不调用真实计费接口。
