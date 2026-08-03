# 参与 BubblePilot 开发

BubblePilot 采用短期功能分支和 Pull Request 进入 `main`。完整流程见[代码管理规范](doc/代码管理规范.md)。

## 快速流程

1. 从最新的 `main` 开始。
2. 创建 `codex/<short-kebab-description>` 分支。
3. 完成一个逻辑变更，并同步补充测试和中文文档。
4. 使用英文 Conventional Commit，例如 `feat(workflow): add conditional node`。
5. 向 `main` 创建 Pull Request，等待 CI 和 Review。
6. 使用 Squash Merge 合并，然后删除短期分支。

禁止提交 Secret、生产聊天数据或本地环境文件。安全漏洞请按照 [SECURITY.md](SECURITY.md) 说明私下报告。
