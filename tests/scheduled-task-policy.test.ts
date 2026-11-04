import { describe, it, expect } from "vitest";
import {
  validateTaskTime,
  scheduledTriggerSchema,
} from "../modules/scheduled-tasks/task-policy.js";
import { strictToolParameters } from "../modules/ai/tool-schema.js";
import {
  createTaskSchema,
  updateTaskSchema,
  cancelTaskSchema,
  listTasksSchema,
} from "../modules/scheduled-tasks/task-policy.js";
import { z } from "zod";
describe("scheduled reminder policy", () => {
  const now = new Date("2030-01-01T00:00:00Z");
  it("validates absolute time, timezone, and horizon", () => {
    expect(
      validateTaskTime(
        "2030-01-02T05:00:00+08:00",
        "Asia/Shanghai",
        now,
      ).toISOString(),
    ).toBe("2030-01-01T21:00:00.000Z");
    expect(() =>
      validateTaskTime("2030-01-02T05:00:00Z", "Asia/Shanghai", now),
    ).toThrow("TASK_TIMEZONE_MISMATCH");
    expect(() => validateTaskTime("2029-01-02T05:00:00Z", "UTC", now)).toThrow(
      "TASK_TIME_OUT_OF_RANGE",
    );
    expect(() => validateTaskTime("2032-01-02T05:00:00Z", "UTC", now)).toThrow(
      "TASK_TIME_OUT_OF_RANGE",
    );
    expect(() =>
      validateTaskTime("2030-03-10T02:30:00-05:00", "America/New_York", now),
    ).toThrow("TASK_TIMEZONE_MISMATCH");
  });
  it("requires explicit chats and rejects unknown tool properties", () => {
    expect(
      scheduledTriggerSchema.safeParse({ enabled: true, chatIds: [] }).success,
    ).toBe(false);
    expect(
      createTaskSchema.safeParse({
        content: "task",
        scheduledAt: "2030-01-02T05:00:00Z",
        timeZone: "UTC",
        chatId: "injected",
      }).success,
    ).toBe(false);
    expect(
      updateTaskSchema.safeParse({
        id: "00000000-0000-4000-8000-000000000001",
        expectedVersion: 1,
      }).success,
    ).toBe(false);
  });
  it("all tools support existing strict-schema adaptation", () => {
    for (const schema of [
      createTaskSchema,
      updateTaskSchema,
      cancelTaskSchema,
      listTasksSchema,
    ])
      expect(() =>
        strictToolParameters({
          name: "fictional_task",
          description: "fixture",
          parameters: z.toJSONSchema(schema, { io: "input" }),
        }),
      ).not.toThrow();
  });
});
