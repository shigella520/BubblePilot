import { z } from "zod";

import { idleTaskInstruction } from "./idle-defaults.js";

export const idleTimeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
      return true;
    } catch {
      return false;
    }
  }, "Invalid IANA time zone.");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);
export const quietPeriodSchema = z
  .object({
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length),
    start: clock,
    end: clock,
  })
  .strict()
  .refine(
    (period) => period.start !== period.end,
    "Quiet period start and end must differ.",
  );

export const idleTriggerSchema = z
  .object({
    enabled: z.boolean().default(false),
    chatIds: z
      .array(z.string().min(1).max(200))
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length)
      .default([]),
    idleMinutes: z.number().int().min(2).max(360).default(60),
    timeZone: idleTimeZoneSchema,
    quietPeriods: z
      .array(quietPeriodSchema)
      .max(20)
      .default([{ days: [1, 2, 3, 4, 5, 6, 7], start: "23:00", end: "09:00" }]),
    dailyLimit: z.number().int().min(2).max(666).default(2),
    taskInstruction: z
      .string()
      .trim()
      .min(1)
      .max(4_000)
      .default(idleTaskInstruction),
  })
  .strict()
  .refine(
    (config) => !config.enabled || config.chatIds.length > 0,
    "Idle triggering requires explicitly selected chats.",
  );
export type IdleTriggerConfig = z.infer<typeof idleTriggerSchema>;

/** Wall-clock comparisons avoid assuming that a local day has 24 hours. */
const formatters = new Map<string, Intl.DateTimeFormat>();
export function isQuiet(instant: Date, config: IdleTriggerConfig): boolean {
  let formatter = formatters.get(config.timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: config.timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    if (formatters.size > 64) formatters.clear();
    formatters.set(config.timeZone, formatter);
  }
  const parts = formatter.formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const day =
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
      values.get("weekday") ?? "",
    ) + 1;
  const time = `${values.get("hour")}:${values.get("minute")}`;
  return config.quietPeriods.some((period) =>
    period.start < period.end
      ? period.days.includes(day) && time >= period.start && time < period.end
      : (period.days.includes(day) && time >= period.start) ||
        (period.days.includes(day === 1 ? 7 : day - 1) && time < period.end),
  );
}

/** Finds the end of the union, including overlaps and DST transitions. */
export function quietUntil(now: Date, config: IdleTriggerConfig): Date | null {
  if (!isQuiet(now, config)) return now;
  let time = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  for (let minutes = 0; minutes < 8 * 24 * 60; minutes++, time += 60_000) {
    const next = new Date(time);
    if (!isQuiet(next, config)) return next;
  }
  return null; // An overlapping weekly schedule can prohibit all sending.
}

export function idleDueAt(
  activityAt: Date,
  config: IdleTriggerConfig,
  asOf?: Date,
): Date | null {
  if (asOf && asOf > activityAt && config.quietPeriods.length) {
    // Find the latest quiet minute since activity, including downtime. Never catch up an old greeting.
    const lower = Math.max(
      activityAt.getTime(),
      asOf.getTime() - 8 * 24 * 60 * 60_000,
    );
    for (
      let minute = Math.floor(asOf.getTime() / 60_000) * 60_000;
      minute >= lower;
      minute -= 60_000
    ) {
      if (isQuiet(new Date(minute), config)) {
        const end = quietUntil(new Date(minute), config);
        if (!end) return null;
        activityAt = new Date(Math.max(activityAt.getTime(), end.getTime()));
        break;
      }
    }
  }
  let due = new Date(activityAt.getTime() + config.idleMinutes * 60_000);
  // Repeated quiet periods may leave no sufficiently long speaking window.
  for (let cycle = 0; cycle < 16; cycle++) {
    if (!isQuiet(due, config)) return due;
    const end = quietUntil(due, config);
    if (!end) return null;
    due = new Date(end.getTime() + config.idleMinutes * 60_000);
  }
  return null;
}

export function idleDay(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

export const idleDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("skip") }).strict(),
  z
    .object({
      action: z.literal("send"),
      text: z.string().trim().min(1).max(12_000),
    })
    .strict(),
]);
export function parseIdleDecision(text: string) {
  return idleDecisionSchema.parse(JSON.parse(text));
}
