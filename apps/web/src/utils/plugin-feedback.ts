import { ApiError } from "../services/api.js";
const messages: Record<string, string> = {
  SENSITIVE_AUTH_REQUIRED: "此操作需要敏感验证，请在顶栏解锁后重试。",
  UNAUTHORIZED: "管理会话已失效，请重新登录。",
  IMPORT_FAILED:
    "插件导入失败，未能取得具体原因。请检查仓库和分支，或上传仅含插件目录的 ZIP 包。此错误不表示敏感验证失败。",
  INTERRUPTED: "导入因服务重启而中断，请重新导入。",
  PLUGIN_GIT_FAILED:
    "无法读取 Git 仓库。请检查公开 HTTPS 地址、分支及服务器网络，或改用插件 ZIP 包。",
  PLUGIN_GIT_TIMEOUT: "读取仓库超时，请检查服务器网络，或上传插件 ZIP 包。",
  PLUGIN_ARCHIVE_TOO_LARGE:
    "插件来源超过文件数量或体积限制。请仅打包需要的插件目录后上传 ZIP。",
  PLUGIN_TEXT_TOO_LARGE: "包内文本文件过大，请缩小插件包后重试。",
  PLUGIN_NO_PLUGIN_MANIFEST:
    "没有找到插件清单。请选择包含 plugin.json 或 .codex-plugin/plugin.json 的插件包，普通项目仓库不能直接安装。",
  PLUGIN_INVALID_ZIP: "ZIP 文件损坏或结构不受支持，请重新打包插件目录。",
  PLUGIN_NETWORK_TARGET_DENIED:
    "目标地址未通过网络安全检查，可能解析到了内网或代理 Fake-IP。请检查服务器 DNS，或使用 ZIP 导入。",
  PLUGIN_INVALID_GIT_URL: "请填写公开 HTTPS Git 仓库地址，不要包含查询参数。",
  PLUGIN_UNSAFE_PATH: "包内存在不安全路径，已拒绝导入。",
  PLUGIN_SYMLINK_DENIED: "包内包含符号链接，已拒绝导入。",
  PLUGIN_UNSAFE_ARCHIVE_ENTRY: "ZIP 包含不支持的文件类型，已拒绝导入。",
};
export function pluginErrorMessage(cause: unknown): string {
  const code =
    cause instanceof ApiError
      ? cause.code
      : cause instanceof Error
        ? cause.message
        : "";
  return (
    messages[code] ??
    (cause instanceof Error ? cause.message : "操作失败，请刷新状态后重试。")
  );
}
export function canInspectPlugin(
  task: { state: string; directories: string[] } | null,
  directory: string,
): boolean {
  return task?.state === "staged" && task.directories.includes(directory);
}
