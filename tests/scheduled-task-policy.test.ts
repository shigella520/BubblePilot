import { describe, it, expect } from "vitest";
import {
  taskSettingsSchema,
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
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { compileMcpSchema } from "../modules/plugins/plugin-schema.js";
describe("scheduled reminder policy", () => {
  it("requires a bounded synthesized request at creation without rewriting it on updates", () => {
    const base = {
      summary: "读书会提醒",
      content: "提醒携带读书会资料",
      timeZone: "UTC",
      schedule: { kind: "once", scheduledAt: "2030-01-02T05:00:00Z" },
    };
    for (const requestSnapshot of [
      undefined,
      null,
      "",
      "   ",
      "字".repeat(8001),
    ])
      expect(
        createTaskSchema.safeParse({ ...base, requestSnapshot }).success,
      ).toBe(false);
    const requestSnapshot = "先约定提醒带资料，随后确认时间并补充需要带书。";
    expect(
      createTaskSchema.parse({
        ...base,
        requestSnapshot: ` ${requestSnapshot} `,
      }).requestSnapshot,
    ).toBe(requestSnapshot);
    expect(
      createTaskSchema.safeParse({
        ...base,
        requestSnapshot: "字".repeat(8000),
      }).success,
    ).toBe(true);
    expect(
      updateTaskSchema.safeParse({
        id: "00000000-0000-4000-8000-000000000001",
        expectedVersion: 1,
        summary: "新概要",
        requestSnapshot,
      }).success,
    ).toBe(false);
  });
  it("validates retention settings without resetting omitted legacy values", () => {
    const base = {
      paused: false,
      pendingLimit: 1000,
      catchupMinutes: 30,
      expectedVersion: 1,
    };
    expect(taskSettingsSchema.parse(base)).not.toHaveProperty("retentionDays");
    for (const days of [7, 30, 180])
      expect(
        taskSettingsSchema.parse({ ...base, retentionDays: days })
          .retentionDays,
      ).toBe(days);
    for (const days of [0, -1, 6, 7.5, 181, "30", null])
      expect(
        taskSettingsSchema.safeParse({ ...base, retentionDays: days }).success,
      ).toBe(false);
  });
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
        summary: "Task",
        requestSnapshot: "Fictional request",
        content: "task",
        schedule: { kind: "once", scheduledAt: "2030-01-02T05:00:00Z" },
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
  it("requires a bounded single-line summary for creation and accepts summary-only updates", () => {
    const input = {
      content: "虚构任务正文",
      requestSnapshot: "请在约定时间提醒虚构事项。",
      timeZone: "UTC",
      schedule: { kind: "once", scheduledAt: "2030-01-02T05:00:00Z" },
    };
    expect(createTaskSchema.safeParse(input).success).toBe(false);
    for (const summary of ["", " ", "字".repeat(41), "第一行\n第二行"])
      expect(createTaskSchema.safeParse({ ...input, summary }).success).toBe(
        false,
      );
    expect(
      createTaskSchema.parse({ ...input, summary: "  虚构提醒  " }).summary,
    ).toBe("虚构提醒");
    expect(
      updateTaskSchema.safeParse({
        id: "00000000-0000-4000-8000-000000000001",
        expectedVersion: 1,
        summary: "补充概要",
      }).success,
    ).toBe(true);
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
  it("uses one schedule field across the tool and service contracts", () => {
    const once = { kind: "once", scheduledAt: "2030-01-02T05:00:00Z" };
    const base = {
      summary: "提醒",
      content: "虚构提醒",
      requestSnapshot: "请设置虚构提醒",
      timeZone: "UTC",
    };
    expect(createTaskSchema.parse({ ...base, schedule: once })).toEqual({
      ...base,
      schedule: once,
    });
    const recurring = {
      kind: "recurring",
      startsAt: "2030-01-02T05:00:00Z",
      rule: { type: "weekly", weekdays: [1, 3], localTime: "05:00" },
      end: { kind: "never" },
    };
    expect(
      createTaskSchema.safeParse({ ...base, schedule: recurring }).success,
    ).toBe(true);
    expect(
      createTaskSchema.safeParse({
        ...base,
        schedule: recurring,
        scheduledAt: once.scheduledAt,
      }).success,
    ).toBe(false);
    expect(
      createTaskSchema.safeParse({ ...base, scheduledAt: once.scheduledAt })
        .success,
    ).toBe(false);
    const update = {
      id: "00000000-0000-4000-8000-000000000001",
      expectedVersion: 1,
    };
    expect(
      updateTaskSchema.safeParse({ ...update, summary: "新概要" }).success,
    ).toBe(true);
    expect(
      updateTaskSchema.safeParse({ ...update, timeZone: "UTC" }).success,
    ).toBe(false);
    expect(
      updateTaskSchema.safeParse({
        ...update,
        timeZone: "UTC",
        schedule: once,
      }).success,
    ).toBe(true);
    expect(
      updateTaskSchema.safeParse({
        ...update,
        scheduledAt: once.scheduledAt,
      }).success,
    ).toBe(false);
  });
  it("matches the public PATCH contract for required changes and removed parameters", () => {
    const doc = parse(
      readFileSync(
        new URL("../contracts/openapi.yaml", import.meta.url),
        "utf8",
      ),
    ) as {
      paths: Record<
        string,
        {
          patch: {
            requestBody: {
              content: {
                "application/json": { schema: Record<string, unknown> };
              };
            };
          };
        }
      >;
      components: { schemas: { TaskSchedule: Record<string, unknown> } };
    };
    const schema =
      doc.paths["/api/v1/scheduled-tasks/{taskId}"]!.patch.requestBody.content[
        "application/json"
      ].schema;
    const validator = compileMcpSchema({
      ...schema,
      $defs: { TaskSchedule: doc.components.schemas.TaskSchedule },
      properties: {
        ...(schema.properties as object),
        schedule: { $ref: "#/$defs/TaskSchedule" },
      },
    });
    const schedule = { kind: "once", scheduledAt: "2030-01-02T05:00:00Z" };
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ expectedVersion: 1 }, false],
      [{ expectedVersion: 1, summary: "新概要" }, true],
      [{ expectedVersion: 1, timeZone: "UTC" }, false],
      [{ expectedVersion: 1, summary: "新概要", timeZone: "UTC" }, false],
      [{ expectedVersion: 1, timeZone: "UTC", schedule }, true],
      [{ expectedVersion: 1, scheduledAt: schedule.scheduledAt }, false],
      [
        { expectedVersion: 1, scheduledAt: schedule.scheduledAt, schedule },
        false,
      ],
    ];
    for (const [input, valid] of cases) {
      expect(validator(input), JSON.stringify(input)).toBe(valid);
      expect(
        updateTaskSchema.safeParse({
          id: "00000000-0000-4000-8000-000000000001",
          ...input,
        }).success,
      ).toBe(valid);
    }
  });
});
