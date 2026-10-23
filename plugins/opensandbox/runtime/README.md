# 单次聊天任务 Python 运行镜像

独立于应用和 MCP 服务的第三个镜像：`ghcr.io/shigella520/bubblepilot-sandbox-python`。
只在需要时创建，同一 AI 任务内复用 `/workspace`，任务结束删除；后续消息不继承文件。

## 构建与验证

在仓库根目录执行（仅构建本地镜像，不发布）：

```sh
docker build --platform linux/amd64 -f plugins/opensandbox/runtime/Dockerfile -t bubblepilot-sandbox-python:test .
sh plugins/opensandbox/runtime/verify.sh
node plugins/opensandbox/runtime/benchmark.mjs python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704 bubblepilot-sandbox-python:test
```

首版发布 linux/amd64。ARM 开发机运行该镜像会模拟执行，测量不能代表 NAS。
`verify.sh` 在 512 MiB、无外网、无额外 capabilities 下验证 CLI、库导入、pip check、CSV/Excel、PDF 文本、图片、HTML/YAML、SQLite、解压和本地 HTTP。
`benchmark.mjs` 比较缓存镜像的三次 Docker 启动至 Python 可用耗时、展开大小、空闲内存及典型任务 RSS；不代表 OpenSandbox 完整创建链路。

## 能力与限制

机器清单位于镜像 `/opt/bubblepilot/capabilities.json`，系统/Python 实际版本分别记录在同目录 `system-packages.tsv` 和 `python-packages.txt`。
预装 CLI 和 Python 模块以仓库 [capabilities.json](capabilities.json) 为准；这不是权限授予，也不是每个工具都可在当前内核执行的保证。
本次精简不引入 gawk、curl、wget、dnsutils、git 及其可避免的依赖。HTTP/下载使用 httpx，文本处理使用 Python/grep/sed，基本域名解析使用 socket；不提供 Git 克隆和 dig 完整诊断。冒烟测试同时检查移除的工具及依赖未被间接装回。
Python 提供 pip/venv；短任务优先预装工具，不临时安装依赖。数学库默认单线程，缓存写入 /tmp。

- Excel 只处理 xlsx，不执行宏，不提供 xls 支持。
- PDF 只提取文本层，无 OCR；Pillow 处理像素，不提供视觉识别。
- 无浏览器、Node/Java/Go、编译器、后台任务和 Notebook 服务。
- 不自动获得聊天附件或历史图片；只能处理明确写入或授权下载的数据。
- 只返回文字，不提供二进制附件下载；生成文件随任务清理。
- 普通 ping/DNS 不走 HTTP 代理，ping 可因内核权限失败，不因此扩大容器权限。
- 单并发、512 MiB、600 秒 TTL 与现有工具预算保持不变；不能承诺处理任意大小文件。

## 依赖、发布与回退

基础镜像固定 digest。`requirements.in` 是直接依赖输入；`requirements.lock` 固定所有解析到的版本与哈希，构建仅安装 wheel 并强制哈希验证。
更新锁文件应在临时 Python 3.12 容器中安装 `pip-tools==7.5.2` 后执行：

```sh
pip-compile --generate-hashes --strip-extras --output-file=requirements.lock requirements.in
```

系统包通过 Debian HTTPS 仓库在构建时安装，不承诺不同日期重建逐字节一致；实际部署固定最终镜像 digest。
CI 独立构建、冒烟测试并用 Trivy 扫描系统/Python 漏洞，新增 HIGH/CRITICAL、可修复项和过期风险基线阻断。Dev 发布时对实际待推送运行镜像再次测试和扫描，不绕过失败或静默忽略漏洞。

升级先准备并预拉取镜像、备份配置，等待任务结束，再将 `SANDBOX_IMAGE` 改为项目镜像 digest 并重建适配服务。
旧 `python:3.12…@sha256:…` 仍有效，能力返回 unknown；保留原 digest 以便回退。不需要数据库迁移、新素材卷或跨轮状态备份。
插件 0.2.0 的 Skill 需在管理页升级并审阅，不自动修改工作流。
NAS CPU CFS/PIDs 能力不足仍需单独评估，本镜像不补齐宿主隔离。

当前候选的精简范围、扫描和验证结果见[精简复核](trim-review.md)。仍有基础系统 HIGH 风险，发布按已审核基础风险例外执行，见 [风险接受记录](risk-acceptance.md)。
