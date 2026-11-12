import { describe, it, expect } from "vitest";
import {
  nextScheduledTime,
  schedulePreview,
  type TaskSchedule,
} from "../modules/scheduled-tasks/task-schedule.js";
import {
  createTaskSchema,
  validateSchedule,
} from "../modules/scheduled-tasks/task-policy.js";
const schedule = (
  rule: Extract<TaskSchedule, { kind: "recurring" }>["rule"],
  startsAt = "2030-01-01T00:00:00Z",
): TaskSchedule => ({
  kind: "recurring",
  startsAt,
  rule,
  end: { kind: "never" },
});
describe("recurring calendar", () => {
  it("preserves local calendar time across DST and skips gaps", () => {
    const s = schedule(
      { type: "daily", localTime: "02:30" },
      "2030-03-09T00:00:00-05:00",
    );
    expect(
      schedulePreview(s, "America/New_York", new Date("2030-03-09T00:00:00Z")),
    ).toEqual([
      "2030-03-09T07:30:00.000Z",
      "2030-03-11T06:30:00.000Z",
      "2030-03-12T06:30:00.000Z",
    ]);
  });
  it("chooses a folded local time once, even when resuming between its two instants", () => {
    const s = schedule(
      { type: "daily", localTime: "01:30" },
      "2030-11-02T00:00:00-04:00",
    );
    expect(
      nextScheduledTime(
        s,
        "America/New_York",
        new Date("2030-11-03T05:00:00Z"),
      )?.toISOString(),
    ).toBe("2030-11-03T05:30:00.000Z");
    expect(
      nextScheduledTime(
        s,
        "America/New_York",
        new Date("2030-11-03T06:00:00Z"),
      )?.toISOString(),
    ).toBe("2030-11-04T06:30:00.000Z");
  });
  it("skips missing month days and supports last day including leap February", () => {
    const s = schedule({ type: "monthly", dayOfMonth: 31, localTime: "08:00" });
    expect(schedulePreview(s, "UTC", new Date("2030-01-01Z"))).toEqual([
      "2030-01-31T08:00:00.000Z",
      "2030-03-31T08:00:00.000Z",
      "2030-05-31T08:00:00.000Z",
    ]);
    expect(
      nextScheduledTime(
        schedule(
          { type: "monthly", dayOfMonth: "last", localTime: "08:00" },
          "2032-01-01T00:00:00Z",
        ),
        "UTC",
        new Date("2032-02-01Z"),
      )?.toISOString(),
    ).toBe("2032-02-29T08:00:00.000Z");
  });
  it("uses selected weekdays and an inclusive start", () => {
    const s = schedule(
      { type: "weekly", weekdays: [1, 3, 5], localTime: "20:00" },
      "2030-01-07T20:00:00+08:00",
    );
    expect(
      schedulePreview(s, "Asia/Shanghai", new Date("2030-01-01Z")),
    ).toEqual([
      "2030-01-07T12:00:00.000Z",
      "2030-01-09T12:00:00.000Z",
      "2030-01-11T12:00:00.000Z",
    ]);
  });
  it("anchors intervals instead of drifting after completion", () => {
    const s = schedule({ type: "interval", everyMinutes: 180 });
    expect(
      nextScheduledTime(
        s,
        "UTC",
        new Date("2030-01-01T03:12:00Z"),
      )?.toISOString(),
    ).toBe("2030-01-01T06:00:00.000Z");
  });
  it("enforces exclusive end, consumed count and nonempty schedules", () => {
    const s = {
      ...schedule({ type: "daily", localTime: "08:00" }),
      kind: "recurring" as const,
      startsAt: "2030-01-01T00:00:00Z",
      rule: { type: "daily" as const, localTime: "08:00" },
      end: { kind: "until" as const, until: "2030-01-02T08:00:00Z" },
    };
    expect(schedulePreview(s, "UTC", new Date("2030-01-01Z"))).toEqual([
      "2030-01-01T08:00:00.000Z",
    ]);
    expect(
      schedulePreview(
        { ...s, end: { kind: "count", count: 3 } },
        "UTC",
        new Date("2030-01-01Z"),
        2,
      ),
    ).toHaveLength(1);
    expect(() =>
      validateSchedule(
        { ...s, end: { kind: "until", until: "2030-01-01T00:01:00Z" } },
        "UTC",
        new Date("2029-12-31Z"),
      ),
    ).toThrow("TASK_SCHEDULE_EMPTY");
  });
  it("rejects contradictory legacy/new fields, short intervals and injected scopes", () => {
    const base = {
      summary: "Fictional reminder",
      content: "fictional",
      timeZone: "UTC",
      schedule: schedule({ type: "interval", everyMinutes: 180 }),
    };
    expect(createTaskSchema.safeParse(base).success).toBe(true);
    expect(
      createTaskSchema.safeParse({
        ...base,
        scheduledAt: "2030-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      createTaskSchema.safeParse({
        ...base,
        schedule: schedule({ type: "interval", everyMinutes: 1 }),
      }).success,
    ).toBe(false);
  });
});
