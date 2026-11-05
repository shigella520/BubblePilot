# 附件传输本地预研

以下脚本只用于独立本机 OpenSandbox 的可行性探测，不是生产附件接口或完整安全验收。默认拒绝非 loopback 服务地址；必须使用独立测试服务和虚构数据，不指向通过隧道映射的生产服务。

## 运行

先启动本地 Docker，并配置独立 OpenSandbox Server：HTTP 仅绑定宿主 `127.0.0.1:28090`，启用随机 API key，沙箱端口绑定 `127.0.0.1`，server proxy 使用内部容器地址。只有控制面挂 Docker Socket，沙箱不挂宿主目录或 Socket。参考官方配置及[插件部署说明](../../../plugins/opensandbox/README.md)。本脚本不自动修改 Docker 或安装软件。

```sh
export SPIKE_URL=http://127.0.0.1:28090
export SPIKE_KEY_FILE=/absolute/path/to/local-test-key
export SPIKE_IMAGE=python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704
export OPENSANDBOX_DISABLE_METRICS=1
node doc/experiments/attachment-sandbox/attachment-transfer.mjs
pnpm exec tsx doc/experiments/attachment-sandbox/attachment-mcp-session.ts
```

依赖来自现有 workspace，不另装宿主数据库或 Python 包。脚本创建 512 MiB、短 TTL 的沙箱并在 finally 中删除；中断或创建响应丢失时须检查该独立服务中的实验元数据，并等待 TTL 清理。不删除其他服务或容器。

- `attachment-transfer.mjs`：流式二进制与哈希、中文 CSV 两阶段导入和计算、SDK 原生符号链接行为、源流中断、SDK 超时、任务隔离及清理。
- `attachment-mcp-session.ts`：使用现有 MCP HTTP 服务、生命周期与真实 OpenSandbox 后端，检查认证、发现不分配、容量限制、两次导入、原 MCP 工具读取、会话结束与隔离。实验通过受控代码直接使用 SDK 上传，**尚未实现应用到适配服务的新认证传输接口**。

符号链接探测只修改虚构沙箱内 `/tmp/spike-outside`，不会测试宿主路径。SDK 返回的 `close()` 仅关闭客户端资源，容器清理必须调用 `kill()` 或既有后端删除接口并核对结果。

## 2026-11-05 本地结果

Docker Desktop Engine 29.9.2，arm64 macOS，Node 26.13.0，SDK 1.1.1。使用上述 Python slim arm64 镜像，非 NAS 的 amd64 薄封装镜像；测试数据全部虚构。

控制面镜像：`opensandbox/server@sha256:bcd5f264101262cebfa7e1ff9cd0424403e42f31a6596e4364cf90d8cb5c936b`。
Execd 镜像：`opensandbox/execd:v1.1.0`，拉取 digest `sha256:6cf7dba2f21f0b536e100563d841ac58a9f31c2b0a081b7ac76796a24d6f47e2`。

| 检查 | 观察 |
| --- | --- |
| 创建 | 镜像已缓存，首次约 1.47 秒；后续样本约 0.53～0.74 秒，不代表 NAS 时延 |
| 二进制流 | 1 MiB、10 MiB 均完整写入且 SHA-256 一致；最后一次上传加远端哈希检查约 1.06 / 1.14 秒 |
| 分阶段处理 | 中文 CSV 分两次导入同一实例；第一阶段已执行命令，第二次导入后合并结果正确 |
| MCP 复用 | 原四工具仍可发现；发现无分配，第二会话容量忙；同一会话可读取两次 SDK 导入的文件 |
| 原生上传路径 | SDK 上传跟随符号链接，修改了沙箱内虚构外部目标；不能作为附件安全入口直接复用 |
| 源流中断 | 上送源抛错后 SDK 拒绝，本样本未留下目标文件；不保证所有中断时机均无残留 |
| 超时 | 1 秒请求超时约 1004ms 返回，但源生成器仍产出全部 12 块；须显式取消源流，不能只依赖 fetch 超时 |
| 会话失败 | 现有文件命令失败会使沙箱失效；后续 DELETE 可返回 404，需要结合已清理状态解释 |
| 隔离与清理 | 新会话无旧文件；最终按实验标识查询剩余沙箱为 0 |
| 原回归 | `pnpm sandbox:verify` 类型、16 项测试及构建通过 |

权限参数需用 SDK 示例的 `700` / `600` 数字，而非 JavaScript 八进制换算后的 `448` / `384`；后者导致 execd 权限解析错误。

## 实施前仍需完成

- 新传输入口的认证、MCP 会话绑定、短期授权、跨执行拒绝、取消传播和幂等核对。
- 上传暂存及安全提交：不允许任意目标路径，校验哈希，用目录描述符/no-follow 等方式防链接绕过；与命令互斥，考虑沙箱后台进程仍可能修改目录。
- 额度、解压限制、磁盘空间监控、恶意路径、并发与部分写入的故障矩阵。
- 历史附件 SQL 查询与原工具分页/预算兼容，以及真实 BlueBubbles 受控下载。
- 真实薄封装镜像上的 XLSX/PDF 与 512 MiB 分析负载、真实模型和 NAS 联调。

本次结果只证明传输与复用的关键可行性，不表示完整需求或生产安全验证已完成。

## 实施后的真实链路验收（2026-11-05）

上面的“实施前仍需完成”记录的是预研时点，不是当前实现状态。新增 `attachment-runtime.ts` 直接使用正式 `AttachmentSession`、网关下载适配器、`PluginSession`、受认证二进制入口及 OpenSandbox 后端；不再使用 SDK 原生文件上传作为正式传输实现。网关与归档授权仍使用虚构本地服务。

```sh
pnpm exec tsx doc/experiments/attachment-sandbox/attachment-runtime.ts
# 可选：SPIKE_FIXTURE_DIR 指向 generate-fixtures.py 生成的目录，补测六种格式。
```

`generate-fixtures.py /output` 应在已有项目 Python 沙箱镜像内运行（可用 `docker run --rm -i --platform linux/amd64 ... python - /output`），只把测试输出目录挂入该一次性生成容器，不向真实任务沙箱挂宿主文件，不向宿主安装 Python 库。默认脚本只测中文 CSV；薄封装镜像测试使用本机已缓存的 `bubblepilot-sandbox-python@sha256:3bd568d8ae5a83ffdb3446509021c83f87f6bccf04a2d591d99a7ecb602bf044`，通过 `SPIKE_IMAGE` 指定。由于开发机是 arm64，该实验入口显式为本机 amd64 镜像选择平台，生产服务没有增加允许模型切换镜像／平台的配置。

| 验证 | 实际结果 |
| --- | --- |
| 正式传输链路 | 同一 MCP 会话先导入昨天 CSV、执行命令、再导入今天 CSV，合计东区 18、西区 20；重复导入不覆盖已修改文件 |
| 薄封装镜像 | XLSX 求和 30；PDF 提取 `Fictional PDF amount 30`；HTML 标题、YAML 数值、PNG 尺寸 7×11、ZIP 受控展开均正确 |
| 时间与内存边界 | 512 MiB 容器完成全部小样本，无 OOM；缓存热身后的六种格式导入约 2.3～4.6 秒；这是 Mac Docker 模拟 amd64 的结果，不代表 NAS 性能或内存峰值基准 |
| 冷启动 | 第一次拉取 amd64 execd 约 37 秒，超过默认 30 秒导入预算时失败并清理；部署应预拉取镜像，不增加默认预算 |
| 清理／隔离 | 每种格式结束关闭会话，确认归属沙箱数和应用临时文件数为 0；新会话拒绝上一会话引用 |
| 安全实现 | 一次性接收器通过 server proxy 传二进制，目录描述符／no-follow／哈希／原子提交；票据绑定 Bearer 和 MCP 会话；无新增宿主公开端口 |

真实 BlueBubbles 服务的原文件下载、NAS 网络与资源限制、真实模型对历史文件的选择和分析质量仍待部署联调。以上没有读取生产消息或修改 NAS。
