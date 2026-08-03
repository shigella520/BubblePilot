import { z } from "zod";

import type { MessageEnvelope } from "../ingestion/message-envelope.js";

const weekdays = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
const weekdaySchema = z.enum(weekdays);
const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);

export const triggerConditionsSchema = z.object({
  chatIds: z.array(z.string().min(1)).max(100).default([]),
  senderIds: z.array(z.string().min(1)).max(100).default([]),
  contentTypes: z
    .array(z.enum(["text", "attachment", "mixed", "unknown"]))
    .max(4)
    .default([]),
  text: z
    .object({
      kind: z.enum(["keyword", "prefix", "regex"]),
      value: z.string().min(1).max(2_000),
      caseSensitive: z.boolean().default(false),
    })
    .nullable()
    .default(null),
  timeWindow: z
    .object({
      timeZone: z.string().min(1).max(100),
      daysOfWeek: z
        .array(weekdaySchema)
        .min(1)
        .max(7)
        .refine((days) => new Set(days).size === days.length, {
          message: "Trigger time-window weekdays must be unique.",
        }),
      start: clockTimeSchema,
      end: clockTimeSchema,
    })
    .refine((window) => window.start !== window.end, {
      message: "Trigger time-window start and end must differ.",
    })
    .nullable()
    .default(null),
});

export type TriggerConditions = z.infer<typeof triggerConditionsSchema>;

export interface TriggerMatchExplanation {
  matched: boolean;
  checks: readonly {
    field:
      "chat" | "sender" | "contentType" | "text" | "timeWindow" | "isFromMe";
    matched: boolean;
  }[];
}

const weekdayIndex = new Map(
  weekdays.map((weekday, index) => [weekday, index] as const),
);

function normalize(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLocaleLowerCase("en-US");
}

function textMatches(
  text: string | null,
  condition: TriggerConditions["text"],
): boolean {
  if (condition === null) {
    return true;
  }
  if (text === null) {
    return false;
  }
  if (condition.kind === "regex") {
    return new RegExp(
      condition.value,
      condition.caseSensitive ? "u" : "iu",
    ).test(text);
  }
  const candidate = normalize(text, condition.caseSensitive);
  const expected = normalize(condition.value, condition.caseSensitive);
  return condition.kind === "prefix"
    ? candidate.startsWith(expected)
    : candidate.includes(expected);
}

function minuteOfDay(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function timeWindowMatches(
  sentAt: string,
  condition: TriggerConditions["timeWindow"],
): boolean {
  if (condition === null) return true;
  const instant = new Date(sentAt);
  if (Number.isNaN(instant.getTime())) return false;
  const parts = new Intl.DateTimeFormat("en-US-u-ca-iso8601", {
    timeZone: condition.timeZone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const weekday = values.get("weekday")?.toLocaleLowerCase("en-US");
  const hour = Number(values.get("hour"));
  const minute = Number(values.get("minute"));
  if (
    weekday === undefined ||
    !weekdayIndex.has(weekday as (typeof weekdays)[number]) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute)
  ) {
    return false;
  }

  const currentDay = weekday as (typeof weekdays)[number];
  const currentMinute = hour * 60 + minute;
  const startMinute = minuteOfDay(condition.start);
  const endMinute = minuteOfDay(condition.end);
  if (startMinute < endMinute) {
    return (
      condition.daysOfWeek.includes(currentDay) &&
      currentMinute >= startMinute &&
      currentMinute < endMinute
    );
  }

  if (currentMinute >= startMinute) {
    return condition.daysOfWeek.includes(currentDay);
  }
  if (currentMinute >= endMinute) return false;
  const currentIndex = weekdayIndex.get(currentDay) ?? 0;
  const previousDay = weekdays[(currentIndex + weekdays.length - 1) % 7];
  return (
    previousDay !== undefined && condition.daysOfWeek.includes(previousDay)
  );
}

export function parseTriggerConditions(value: unknown): TriggerConditions {
  const conditions = triggerConditionsSchema.parse(value);
  if (conditions.text?.kind === "regex") {
    try {
      void new RegExp(
        conditions.text.value,
        conditions.text.caseSensitive ? "u" : "iu",
      );
    } catch {
      throw new Error("The trigger text condition contains an invalid regex.");
    }
  }
  if (conditions.timeWindow !== null) {
    try {
      void new Intl.DateTimeFormat("en-US", {
        timeZone: conditions.timeWindow.timeZone,
      }).format(new Date(0));
    } catch {
      throw new Error(
        "The trigger time window contains an invalid IANA time zone.",
      );
    }
  }
  return conditions;
}

export function matchTrigger(
  envelope: MessageEnvelope,
  conditions: TriggerConditions,
  includeFromMe: boolean,
): TriggerMatchExplanation {
  const checks: TriggerMatchExplanation["checks"] = [
    {
      field: "isFromMe",
      matched: includeFromMe || !envelope.message.isFromMe,
    },
    {
      field: "chat",
      matched:
        conditions.chatIds.length === 0 ||
        conditions.chatIds.includes(envelope.chat.providerChatId),
    },
    {
      field: "sender",
      matched:
        conditions.senderIds.length === 0 ||
        (envelope.message.senderId !== null &&
          conditions.senderIds.includes(envelope.message.senderId)),
    },
    {
      field: "contentType",
      matched:
        conditions.contentTypes.length === 0 ||
        conditions.contentTypes.includes(envelope.message.contentType),
    },
    {
      field: "text",
      matched: textMatches(envelope.message.text, conditions.text),
    },
    {
      field: "timeWindow",
      matched: timeWindowMatches(
        envelope.message.sentAt,
        conditions.timeWindow,
      ),
    },
  ];
  return { matched: checks.every((check) => check.matched), checks };
}
