import { describe, expect, it } from "vitest";
import { modelTaskView } from "../modules/scheduled-tasks/task-service.js";

describe("scheduled task tool view", () => {
  it("renders task times in the task timezone without touching other fields", () => {
    const task = {
      id: "fixture-task",
      scheduledAt: "2026-11-26T16:00:00.000Z",
      nextScheduledAt: "2026-11-26T16:00:00.000Z",
      upcoming: ["2026-11-26T16:00:00.000Z", "2026-11-27T16:00:00.000Z"],
      timeZone: "Asia/Shanghai",
      schedule: { kind: "recurring", startsAt: "2026-11-09T00:00:00+08:00" },
    };
    const view = modelTaskView(task);
    expect(view).toEqual({
      ...task,
      scheduledAt: "2026-11-27T00:00:00+08:00",
      nextScheduledAt: "2026-11-27T00:00:00+08:00",
      upcoming: ["2026-11-27T00:00:00+08:00", "2026-11-28T00:00:00+08:00"],
    });
    expect(task.scheduledAt).toBe("2026-11-26T16:00:00.000Z");
    expect(
      modelTaskView({ ...task, nextScheduledAt: null }).nextScheduledAt,
    ).toBe(null);
  });
});
