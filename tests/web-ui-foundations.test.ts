import { describe, expect, it } from "vitest";
import {
  ApiError,
  diagnosticSeparator,
  errorMessage,
} from "../apps/web/src/services/api.js";
import {
  auditActionLabel,
  enumLabel,
  statusLabel,
} from "../apps/web/src/utils/status-labels.js";
import {
  confirmAction,
  confirmState,
} from "../apps/web/src/services/confirm.js";
import {
  formatBytes,
  formatDateTime,
  formatDuration,
} from "../apps/web/src/utils/format.js";
import {
  partialFailureMessage,
  settleAll,
} from "../apps/web/src/utils/settle.js";

describe("web UI foundations", () => {
  it("maps backend states to Chinese labels and semantic tones", () => {
    expect(statusLabel("execution", "dead-lettered")).toEqual({
      label: "重试耗尽",
      tone: "danger",
    });
    expect(statusLabel("workflow", "active")).toEqual({
      label: "已启用",
      tone: "success",
    });
    expect(statusLabel("memoryJob", "failed").tone).toBe("danger");
    expect(statusLabel("memoryJob", "succeeded").tone).toBe("success");
    // Unknown values stay visible and neutral.
    expect(statusLabel("execution", "fictional-state")).toEqual({
      label: "fictional-state",
      tone: "neutral",
    });
    expect(statusLabel("execution", null).label).toBe("—");
  });

  it("formats times, sizes and durations independent of browser locale", () => {
    expect(formatDateTime(new Date(2026, 10, 27, 9, 5, 7))).toBe(
      "2026-11-27 09:05:07",
    );
    expect(formatDateTime("not a date")).toBe("—");
    expect(formatDateTime(null, "不限")).toBe("不限");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatDuration(850)).toBe("850 毫秒");
    expect(formatDuration(12_300)).toBe("12.3 秒");
    expect(formatDuration(245_000)).toBe("4 分 05 秒");
  });

  it("keeps error codes and request ids out of the readable message", () => {
    const chinese = errorMessage(
      new ApiError(409, "WORKFLOW_CONFLICT", "工作流已被修改。", "req-1"),
    );
    expect(chinese).toBe(
      `工作流已被修改。${diagnosticSeparator}WORKFLOW_CONFLICT · req-1`,
    );
    // Untranslated server text becomes a readable status message; the raw
    // text moves into diagnostics.
    const english = errorMessage(
      new ApiError(
        409,
        "MEMORY_VERSION_CONFLICT",
        "Refresh memory settings before saving.",
        "req-2",
      ),
    );
    expect(english.split(diagnosticSeparator)[0]).toBe(
      "数据已被其他操作修改，请刷新后重试。",
    );
    expect(english).toContain("Refresh memory settings before saving.");
    expect(errorMessage(new ApiError(500, "X", "boom", null))).toContain(
      "服务暂时不可用",
    );
    expect(errorMessage(new Error("本地错误"))).toBe("本地错误");
  });

  it("loads sections independently and names the failed ones", async () => {
    const { values, failed } = await settleAll({
      ok: () => Promise.resolve(1),
      broken: () => Promise.reject(new Error("离线")),
    });
    expect(values.ok).toBe(1);
    expect(values.broken).toBeUndefined();
    expect(failed.map((f) => f.key)).toEqual(["broken"]);
    expect(
      partialFailureMessage(
        failed,
        { ok: "正常", broken: "触发器" },
        (cause) => (cause as Error).message,
      ),
    ).toBe("部分内容未能加载：触发器。可点击刷新重试。\n离线");
    expect(partialFailureMessage([], {}, String)).toBe("");
  });

  it("confirms through one in-app dialog with danger defaults", async () => {
    const pending = confirmAction("确认删除工作流「示例」？");
    expect(confirmState.current).toMatchObject({
      confirmText: "确认删除",
      danger: true,
    });
    confirmState.current!.resolve(true);
    await expect(pending).resolves.toBe(true);
    expect(confirmState.current).toBeNull();

    const first = confirmAction("跳过下一次？", { danger: false });
    expect(confirmState.current?.danger).toBe(false);
    // A newer request supersedes an unanswered one as cancelled.
    const second = confirmAction("暂停周期？", { confirmText: "暂停" });
    await expect(first).resolves.toBe(false);
    confirmState.current!.resolve(false);
    await expect(second).resolves.toBe(false);
  });

  it("translates enums and audit actions, keeping unknown values visible", () => {
    expect(enumLabel("eventType", "new-message")).toBe("新消息");
    expect(enumLabel("operationsAlert", "WORKFLOW_QUEUE_SATURATED")).toBe(
      "工作流队列已满",
    );
    expect(enumLabel("nodeType", "ai-chat")).toBe("AI 对话");
    expect(enumLabel("chatType", "fictional")).toBe("fictional");
    expect(enumLabel("chatType", null)).toBe("—");
    expect(auditActionLabel("ai.provider.create")).toBe("AI Provider · 创建");
    expect(auditActionLabel("scheduled-task.skip")).toBe("定时任务 · 跳过");
    expect(auditActionLabel("fictional.unknown-verb")).toBe(
      "fictional · unknown-verb",
    );
    expect(statusLabel("operations", "attention")).toEqual({
      label: "需关注",
      tone: "warning",
    });
  });
});
