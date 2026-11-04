import { describe, expect, it } from "vitest";
import { serializeTriggerConfig } from "../apps/web/src/utils/workflow-trigger-config.js";
import { scheduledTriggerSchema } from "../modules/scheduled-tasks/task-policy.js";

describe("canvas trigger configuration persistence", () => {
  it("retains reminder settings across save, reload and a second save", () => {
    const scheduled = {
      enabled: true,
      chatIds: ["fictional-chat"],
      timeZone: "Asia/Shanghai",
      memberPendingLimit: 7,
    };
    const saved = serializeTriggerConfig({ scheduled, textValue: "Bot" });
    const loaded = JSON.parse(JSON.stringify(saved)) as Record<string, unknown>;
    expect(scheduledTriggerSchema.parse(loaded.scheduled)).toEqual(scheduled);
    const resaved = serializeTriggerConfig({
      ...loaded,
      textKind: "prefix",
      textValue: "Bot",
    });
    expect(resaved).toEqual(saved);
    expect(resaved.text).toEqual({
      kind: "prefix",
      value: "Bot",
      caseSensitive: false,
    });
    expect(
      serializeTriggerConfig({
        ...loaded,
        scheduled: { ...scheduled, enabled: false },
      }).scheduled,
    ).toEqual({ ...scheduled, enabled: false });
  });
  it("leaves reminders absent for legacy workflows and preserves idle settings", () => {
    const idle = { enabled: false, idleMinutes: 60 };
    const saved = serializeTriggerConfig({ idle, enabled: true });
    expect(saved).not.toHaveProperty("scheduled");
    expect(saved.idle).toEqual(idle);
    expect(saved.enabled).toBe(true);
    expect(saved.text).toBeNull();
  });
});
