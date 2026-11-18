# 沙箱 SVG → PNG → 聊天发送：可行性验证

日期：2026-11-18。基于主干 `60854c2`，仅新增实验和文档，不修改正式工具、数据库、运行时或生产配置。

## 结论

**技术路线可行，可以进入正式开发。** 中文 SVG 渲染、PNG 原样导出、沙箱关闭后继续使用文件、现有 BlueBubbles 附件适配器复用均已通过本地实验。当前结果不代表功能已上线，也不代表真实模型、OpenSandbox 代理和 iMessage 全链路已经验收。

后续实施范围与合同见[沙箱绘图与聊天图片回复技术方案](../../技术方案-沙箱绘图与聊天图片回复.md)。本文保留预研时点的结果与限制，不替代正式设计。

建议链路：模型写 SVG → 沙箱内渲染 PNG → 可选看图调整 → 准备图片工具导出并持久化 → 关闭沙箱 → 原回复节点发送到当前聊天。

## 环境与复现

- Mac Docker Desktop，Docker 29.9.2；显式使用 `linux/amd64`，1 CPU、512 MiB、64 PID。
- 非 root、只读根文件系统、去掉 Linux capabilities；`/workspace` 为 64 MiB tmpfs。仅实验目录只读挂载，无 Docker socket、生产配置和聊天数据。
- 与正式沙箱相同的 Python 3.12 基础镜像 digest；实验镜像只安装 resvg 0.45.1、Noto Sans CJK SC 字体、Pillow 13.0.0。**不是完整正式运行时镜像构建**。
- 二进制及字体在 Dockerfile 中校验固定 SHA-256；下载来源在 `prepare.sh`。字体约 16 MiB，不需要浏览器或 Node.js 进入 Python 沙箱。
- 第一轮容器 `--network none` 验证离线渲染；第二轮只在宿主 loopback 暴露实验 HTTP 端口，验证原图传输。

在仓库根目录执行：

```sh
sh doc/experiments/svg-chat-image/prepare.sh
pnpm exec tsx doc/experiments/svg-chat-image/run.ts
pnpm exec vitest run tests/bluebubbles-rest-reply-gateway.test.ts tests/meme-attachment.test.ts
pnpm docs:check
```

入口：[run.ts](run.ts)、[沙箱探针](probe.py)、[虚构图表 SVG](chart.svg)。运行后输出 `output/chart.png`、`output/results.json`、`output/offline-render.json`；生成文件与下载缓存被 Git 忽略。[evidence.json](evidence.json) 保留此次实测结果。

脚本自动删除自身创建的具名容器，保留本地实验镜像及预览；异常强制中断后按 `bp-svg-probe-` 前缀核对，仅清理本次容器。实验镜像可手动删除：`docker image rm bp-svg-feasibility:local`。

## 实测结果

| 技术点 | 结果 | 正式实现含义 |
| --- | --- | --- |
| 中文、渐变、阴影、圆角裁剪、透明背景 | 1200×760：197,353 字节；连续四次约 0.153～0.160 秒；人工查看 PNG，无乱码和内容遮挡 | 可用原生 SVG 绘制中文统计图、卡片和流程图 |
| 高清导出 | 2400×1520：461,259 字节；约 0.410 秒；透明角落保留 | 发送原 PNG；不借用会压缩的 `view_image` 预览 |
| 资源占用 | 上述渲染子进程最大 RSS 79,712 KiB，约 77.8 MiB；512 MiB 容器完成实验 | 小图无需加大沙箱内存；不代表复杂图表的最坏情况上限 |
| 离线渲染 | 禁网容器同样通过 | 运行时提前装好字体和渲染器，绘图时无需联网安装 |
| 二进制导出 | 461 KB 图表和 3,151,219 字节噪声 PNG 均完整接收，SHA-256 一致 | 独立二进制传输，可避开命令 stdout 的 1 MiB 限制；不把 PNG base64 塞进模型文本 |
| 文件生命周期 | 准备后修改源文件不改变快照；删除沙箱后宿主文件仍可解码和发送 | 导出必须发生在 AI 会话关闭前 |
| 导出路径和类型 | 拒绝路径穿越、工作区外路径、文件/目录符号链接、FIFO、假 PNG、截断 PNG、超过 8 MiB、超过 1600 万像素 | 目录描述符/no-follow、限量读取、完整解码值得复用为正式边界 |
| 传输失败 | 错误 token、截断响应、哈希不符、超大小、预取消和传输中超时均拒绝 | 完整验证前不得提交文件或进入发送队列 |
| 发送合同 | 使用正式 `BlueBubblesRestReplyGateway` 请求本地假服务；核对 multipart 文件、哈希、文件名、聊天、tempGuid、MIME 均一致 | `sendAttachment` 可以复用，无需新网关 API |
| 发送异常 | 200+guid 为 confirmed；429 为 failed；503 和缺少 guid 为 unknown；4 次调用只有 4 次请求 | 继续保留未知结果不盲重发的设计 |

时间仅为本机 amd64 容器内渲染进程的样本，**不含模型生成、拉镜像、创建沙箱和真实消息发送**。第一张图片也不是“全系统冷启动”基准；不据此承诺 NAS 端到端延迟。

## 发现的限制

1. `foreignObject` 内嵌 HTML 返回成功但图片为空白。正式提示词必须要求原生 SVG 的 `text`、`tspan`、路径等；HTML 排版不能作为默认方案，长文本需要明确换行。
2. resvg 能读取 SVG 相对路径引用的图片。实验中的 `file://`、HTTP 引用未加载，外部 XML 实体报错；这几个样本不能证明渲染器可以充当通用安全过滤器。
3. 探针提供窄范围 preflight，拒绝外部引用、HTML、脚本、实体、过大输入和画布。它只是可行性演示，**不是经过完整绕过测试的 SVG sanitizer**。正式方案应限定 SVG 子集/资源解析能力；PNG 导出边界还必须独立校验。
4. `view_image` 最长边 2048、预览上限 512 KiB，可能改成 JPEG。因此看图预览和最终文件导出应各自保留用途。
5. 现有 Reply 节点要求非空文字，表情投递计划依赖 meme 资源。生成图片不能伪装成表情库资产；需新增通用图片产物与图片单独回复能力。

## 开发改造点

| 模块 | 建议改造 |
| --- | --- |
| 沙箱镜像 | 固定渲染器和字体，保留许可证，补齐字体/绘图能力声明；完整镜像扫描、构建和冒烟 |
| 工具 | 新增类似 `prepare_chat_image(path)` 的准备工具；只准备产物，不直接发送；模型不指定任意目标聊天 |
| 导出通道 | 参照现有附件导入的一次性 helper + server proxy，反向传 PNG；绑定 MCP 会话/执行身份、短期票据、来源和额度 |
| 文件存储 | BP 侧验证、原子提交、文件与元数据持久化、哈希、清理期限、备份覆盖；不得把临时沙箱路径当永久引用 |
| 工作流输出 | AI 输出携带受控产物引用；Reply 支持图片单独回复和文字加图片；明确顺序、部分成功与幂等键 |
| 恢复与审计 | 发送前持久化计划，未知结果不自动重发，重启恢复、过期清理、产物预览与失败原因 |

建议首版一轮最多一张 PNG，仅发送当前触发聊天；具体额度、权限和保留期由后续技术方案确定。实验的 8 MiB / 1600 万像素是探测参数，不是已发布合同。

## 未验证与后续验收

- 本轮是 Docker 容器直连 loopback HTTP，**未启动真实 OpenSandbox Server，也未穿过它的 server proxy 或正式 MCP 导出接口**。SDK 1.1.1 虽支持 `readBytesStream`，它直接按路径下载，不能替代本项目的路径安全校验。
- token 仅用于本地探针认证；正式的单次票据、跨任务隔离、并发和后台进程竞态测试尚未实施。文件快照测试覆盖准备后的修改，不声称覆盖所有并发写入攻击。
- 本地文件在沙箱删除后留存已验证；应用进程崩溃、电源故障时的 fsync、数据库事务与幂等恢复尚未验证。
- 噪声图用于证明大二进制导出，不是 SVG 复杂度压测。超时和内存上限仍需复杂滤镜、路径爆炸和多任务并发测试。
- 未调用真实模型、BlueBubbles 或 iMessage，没有发送真实消息。最终需要验收“用户要求绘图 → 模型生成并检查 → 导出 → 聊天收到 PNG”，并验证网关失败/未知结果不会重复发送。
- 本次只新增实验与文档，未运行全量 `pnpm verify`、依赖安全扫描或 PostgreSQL 集成；正式开发完成后按[开发与发布](../../开发与发布.md)执行全套验证。

## 正式实现后的本地导出验证（2026-11-18）

上面的“未验证”描述预研时点；当前新增 [runtime.ts](runtime.ts)，直接使用正式 SDK Backend、MCP认证、单次导出票据、server proxy、沙箱helper和BP PNG校验。独立本地 OpenSandbox、execd v1.1.0 和刚构建的 `bubblepilot-sandbox-python:svg-test` 通过，结果为2400×1520、461259字节、SHA-256 `74ce1dd2ab532b177fae2fe395b4b6e739bf66c92e52d3fe81025649977683fb`。输出在 `output/runtime-chart.png`；链接/越界被拒绝，正常文件仍可继续导出；finally 清理实验所属沙箱。

```sh
# 仅指向独立的本地控制面，API key 放本机受保护文件。
SPIKE_URL=http://127.0.0.1:28090 SPIKE_KEY_FILE=/absolute/path/to/local-key pnpm exec tsx doc/experiments/svg-chat-image/runtime.ts
```

控制面仅loopback暴露、启用随机API key，proxy.resolve_internal=true；控制面容器加入默认bridge，任务使用bridge、宿主端口只绑定127.0.0.1。只有控制面挂Docker socket，任务不挂宿主目录。实验脚本只为本机amd64运行镜像显式选择平台，不改变生产配置。完整应用、数据库与UI验证结果见[验收与演练](../../验收与演练.md)。真实模型和iMessage发送仍未执行。
