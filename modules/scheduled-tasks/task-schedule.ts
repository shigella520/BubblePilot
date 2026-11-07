import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

const instant = z.iso.datetime({ offset: true });
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const scheduleSchema = z.union([
  z.object({ kind: z.literal("once"), scheduledAt: instant }).strict(),
  z
    .object({
      kind: z.literal("recurring"),
      startsAt: instant,
      rule: z.union([
        z.object({ type: z.literal("daily"), localTime }).strict(),
        z
          .object({
            type: z.literal("weekly"),
            weekdays: z
              .array(z.number().int().min(1).max(7))
              .min(1)
              .max(7)
              .refine((v) => new Set(v).size === v.length),
            localTime,
          })
          .strict(),
        z
          .object({
            type: z.literal("monthly"),
            dayOfMonth: z.union([
              z.number().int().min(1).max(31),
              z.literal("last"),
            ]),
            localTime,
          })
          .strict(),
        z
          .object({
            type: z.literal("interval"),
            everyMinutes: z.number().int().min(60).max(525600),
          })
          .strict(),
      ]),
      end: z.union([
        z.object({ kind: z.literal("never") }).strict(),
        z.object({ kind: z.literal("until"), until: instant }).strict(),
        z
          .object({
            kind: z.literal("count"),
            count: z.number().int().min(1).max(10000),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
export type TaskSchedule = z.infer<typeof scheduleSchema>;

/** Exclusive after boundary. Calendar gaps are skipped; folds use the earlier instant. */
export function nextScheduledTime(
  schedule: TaskSchedule,
  zone: string,
  after: Date,
  consumed = 0,
): Date | null {
  if (schedule.kind === "once") {
    const at = new Date(schedule.scheduledAt);
    return at > after && consumed === 0 ? at : null;
  }
  if (schedule.end.kind === "count" && consumed >= schedule.end.count)
    return null;
  const start = new Date(schedule.startsAt).getTime();
  const lower = Math.max(start, after.getTime() + 1);
  const upper =
    schedule.end.kind === "until"
      ? new Date(schedule.end.until).getTime()
      : Infinity;
  if (lower >= upper) return null;
  const rule = schedule.rule;
  if (rule.type === "interval") {
    const step = rule.everyMinutes * 60000;
    const at = start + Math.max(0, Math.ceil((lower - start) / step)) * step;
    return at < upper ? new Date(at) : null;
  }
  let day = Temporal.Instant.fromEpochMilliseconds(lower)
    .toZonedDateTimeISO(zone)
    .toPlainDate();
  // All supported calendar rules have a valid occurrence within a year.
  for (let i = 0; i < 370; i++, day = day.add({ days: 1 })) {
    if (rule.type === "weekly" && !rule.weekdays.includes(day.dayOfWeek))
      continue;
    if (
      rule.type === "monthly" &&
      day.day !==
        (rule.dayOfMonth === "last" ? day.daysInMonth : rule.dayOfMonth)
    )
      continue;
    const local = day.toPlainDateTime(rule.localTime);
    const zoned = local.toZonedDateTime(zone, { disambiguation: "earlier" });
    if (!zoned.toPlainDateTime().equals(local)) continue;
    const at = zoned.epochMilliseconds;
    if (at >= upper) return null;
    if (at >= lower) return new Date(at);
  }
  return null;
}

export function schedulePreview(
  schedule: TaskSchedule,
  zone: string,
  after: Date,
  consumed = 0,
): string[] {
  const result: string[] = [];
  for (let i = 0; i < 3; i++) {
    const next = nextScheduledTime(schedule, zone, after, consumed + i);
    if (!next) break;
    result.push(next.toISOString());
    after = next;
  }
  return result;
}
export function scheduleSummary(schedule: TaskSchedule): string {
  if (schedule.kind === "once") return "单次提醒";
  const r = schedule.rule;
  const base =
    r.type === "interval"
      ? `每隔 ${r.everyMinutes} 分钟`
      : r.type === "daily"
        ? `每天 ${r.localTime}`
        : r.type === "weekly"
          ? `每周 ${[...r.weekdays]
              .sort()
              .map((d) => "一二三四五六日"[d - 1])
              .join("、")} ${r.localTime}`
          : `每月 ${r.dayOfMonth === "last" ? "最后一天" : `${r.dayOfMonth} 日`} ${r.localTime}`;
  return `${base}；${schedule.end.kind === "never" ? "直到取消" : schedule.end.kind === "count" ? `共 ${schedule.end.count} 个计划次数（失败、过期、跳过也计次）` : `截止 ${schedule.end.until}（不含）`}`;
}
