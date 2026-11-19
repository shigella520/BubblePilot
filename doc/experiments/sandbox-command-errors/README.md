# 沙箱确定失败恢复验证

只使用虚构文件和本地一次性容器，不访问生产 API。上游 execd `docker/execd/v1.1.0`（提交 `48b0215f1bd097b31d0f022a44640e00c11ac49d`）的 `components/execd/pkg/runtime/command.go` 在前台 Wait 返回非零退出后发出 `CommandExecError` 与 evalue，然后返回，不发送 execution_complete；控制器对错误终点也结束事件流。SDK 1.1.1 的 inferForegroundExitCode 同样从 error.value 解析退出码。

运行镜像先按[运行镜像说明](../../../plugins/opensandbox/runtime/README.md)构建和验证。在本机一次性运行镜像内启动真实 execd v1.1.0（镜像 digest `sha256:6cf7dba2f21f0b536e100563d841ac58a9f31c2b0a081b7ac76796a24d6f47e2`），仅绑定 `127.0.0.1:28479` 至容器 44772，测试访问令牌固定为虚构值 `fictional-contract-token`。执行：

```sh
pnpm exec tsx doc/experiments/sandbox-command-errors/run.ts
```

脚本使用正式 SandboxPool、文件写入命令和 collectOutput，执行：创建工作区 → 写 SVG → 相对路径渲染失败 → 相同会话用绝对路径修正 → 验证 PNG。输出仅事件类型、退出码和结论，不含生产内容。它验证真实 execd 事件与同会话恢复，不等于真实模型、NAS 或 BlueBubbles 联调；MCP HTTP 合同和附件准备审计分别由自动化测试验证。运行结束删除测试容器，不能复用生产沙箱。

2026-11-19 本地实测通过：错误命令以 `error / CommandExecError / 1` 结束且无 `execution_complete`，结果正确识别为 `command_failed`；同一会话随后渲染和 PNG 校验返回 `completed / 0`。依赖安全与自动化验证结果统一记录于[验收与演练](../../验收与演练.md)。
