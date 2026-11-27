import { reactive } from "vue";

/**
 * In-app replacement for window.confirm: one styled, accessible dialog that
 * states the impact of the action. Rendered once by ConfirmHost in App.vue.
 */
export interface ConfirmRequest {
  title: string;
  message: string;
  confirmText: string;
  danger: boolean;
}

export const confirmState = reactive<{
  current: (ConfirmRequest & { resolve: (ok: boolean) => void }) | null;
}>({ current: null });

const dangerWords = ["删除", "卸载", "撤销", "关闭", "取消", "停用", "丢弃"];

export function confirmAction(
  message: string,
  options: Partial<Omit<ConfirmRequest, "message">> = {},
): Promise<boolean> {
  // A newer request supersedes an unanswered one (treated as cancelled).
  confirmState.current?.resolve(false);
  const verb = ["删除", "卸载", "停用", "关闭"].find((w) =>
    message.includes(w),
  );
  return new Promise((resolve) => {
    confirmState.current = {
      title: options.title ?? "请确认操作",
      message,
      confirmText: options.confirmText ?? (verb ? `确认${verb}` : "确认"),
      danger:
        options.danger ?? dangerWords.some((word) => message.includes(word)),
      resolve: (ok) => {
        confirmState.current = null;
        resolve(ok);
      },
    };
  });
}
