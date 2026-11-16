import { z } from "zod";
export class ChatQueryError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
const timeOfDay = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine((value) => (value.match(/\.(\d+)/u)?.[1]?.length ?? 0) <= 6, {
    message: "Timestamps may have at most six fractional-second digits.",
  });
function instantMicros(value: string): bigint {
  if (!Number.isFinite(Date.parse(value))) return 0n;
  const fraction = value.match(/\.(\d+)/u)?.[1] ?? "";
  return (
    BigInt(Date.parse(value)) * 1000n +
    BigInt(fraction.padEnd(6, "0").slice(3, 6))
  );
}
const fields = {
  botWorkflowId: z
    .string()
    .uuid()
    .optional()
    .describe("Exact Bot workflow UUID; mutually exclusive with senderId."),
  senderId: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe("Exact known sender ID; mutually exclusive with botWorkflowId."),
  from: timestamp.optional(),
  to: timestamp.optional(),
  dailyTime: z
    .object({ from: timeOfDay, to: z.union([timeOfDay, z.literal("24:00")]) })
    .strict()
    .refine((v) => v.from !== v.to, {
      message: "dailyTime from and to must differ.",
    })
    .optional(),
  keywords: z
    .array(z.string().trim().min(1).max(100))
    .min(1)
    .max(10)
    .optional()
    .describe(
      "One to ten literal keywords; must be supplied together with keywordMode.",
    ),
  keywordMode: z
    .enum(["all", "any"])
    .optional()
    .describe("Match all or any keywords; supply only with keywords."),
};
const validIdentity = (v: ChatFilters) => !(v.senderId && v.botWorkflowId);
const validRange = (v: ChatFilters) =>
  !v.from || !v.to || instantMicros(v.from) <= instantMicros(v.to);
const validKeywords = (v: ChatFilters) =>
  (v.keywords !== undefined) === (v.keywordMode !== undefined);
const identityRule = "Use either senderId or botWorkflowId, not both.";
const rangeRule = "from must be no later than to.";
const keywordRule = "Provide keywords and keywordMode together.";
const attachmentRule =
  "Do not combine hasAttachments=false with attachmentName or attachmentType.";
const groupRangeRule = "Time grouping requires both from and to.";
const groupCursorRule = "An ungrouped query cannot use a cursor.";
const breakdownRule =
  "breakdownBy requires a time grouping; hourOfDay breakdown requires weekday grouping.";
export const chatQueryValidationRules = [
  identityRule,
  rangeRule,
  keywordRule,
  attachmentRule,
  groupRangeRule,
  groupCursorRule,
  breakdownRule,
  "Timestamps may have at most six fractional-second digits.",
  "dailyTime from and to must differ.",
] as const;
export interface ChatFilters {
  senderId?: string | undefined;
  botWorkflowId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  dailyTime?: { from: string; to: string } | undefined;
  keywords?: string[] | undefined;
  keywordMode?: "all" | "any" | undefined;
  hasAttachments?: boolean | undefined;
  attachmentName?: string | undefined;
  attachmentType?: string | undefined;
  authorKind?: "participant" | "bot" | "unknown" | undefined;
}
const cursor = z.string().uuid().optional();
const attachmentFields = {
  hasAttachments: z
    .boolean()
    .optional()
    .describe(
      "false cannot be combined with attachmentName or attachmentType.",
    ),
  attachmentName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Literal filename filter; cannot be combined with hasAttachments=false.",
    ),
  attachmentType: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?:[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+|\.[a-z0-9]{1,16})$/u)
    .optional()
    .describe(
      "Exact MIME or extension; cannot be combined with hasAttachments=false.",
    ),
};
export const chatMessageQuerySchema = z
  .object({
    ...fields,
    ...attachmentFields,
    attachmentOffset: z.number().int().min(0).max(10000).optional(),
    order: z.enum(["asc", "desc"]).default("desc"),
    limit: z.number().int().min(1).max(50).default(20),
    cursor,
  })
  .strict()
  .refine(validIdentity, { message: identityRule })
  .refine(validRange, { message: rangeRule })
  .refine(validKeywords, { message: keywordRule })
  .refine(
    (v) =>
      v.hasAttachments !== false || (!v.attachmentName && !v.attachmentType),
    { message: attachmentRule },
  );
const groupFields = {
  ...fields,
  groupBy: z.enum(["none", "day", "sender"]).default("none"),
  limit: z.number().int().min(1).max(100).default(31),
  cursor,
};
const validGroupCursor = (v: {
  groupBy: string;
  cursor?: string | undefined;
}) => v.groupBy !== "none" || !v.cursor;
export const chatCountQuerySchema = z
  .object({
    ...groupFields,
    ...attachmentFields,
    groupBy: z
      .enum([
        "none",
        "hour",
        "day",
        "week",
        "month",
        "sender",
        "hourOfDay",
        "weekday",
      ])
      .default("none")
      .describe(
        "Time grouping requires both from and to. none cannot use a cursor.",
      ),
    breakdownBy: z
      .enum(["sender", "hourOfDay"])
      .optional()
      .describe(
        "Only with a time grouping: sender for any time group; hourOfDay only for weekday.",
      ),
    orderBy: z.enum(["group", "countDesc"]).optional(),
    authorKind: z.enum(["participant", "bot", "unknown"]).optional(),
  })
  .strict()
  .refine(validIdentity, { message: identityRule })
  .refine(validRange, { message: rangeRule })
  .refine(validKeywords, { message: keywordRule })
  .refine(validGroupCursor, { message: groupCursorRule })
  .refine(
    (v) =>
      v.hasAttachments !== false || (!v.attachmentName && !v.attachmentType),
    { message: attachmentRule },
  )
  .refine((v) => ["none", "sender"].includes(v.groupBy) || !!(v.from && v.to), {
    message: groupRangeRule,
  })
  .refine(
    (v) =>
      !v.breakdownBy ||
      (!["none", "sender"].includes(v.groupBy) &&
        (v.breakdownBy === "sender" || v.groupBy === "weekday")),
    {
      message: breakdownRule,
    },
  );
export const chatExtremaQuerySchema = z
  .object({ ...groupFields, pick: z.enum(["first", "last"]) })
  .strict()
  .refine(validIdentity, { message: identityRule })
  .refine(validRange, { message: rangeRule })
  .refine(validKeywords, { message: keywordRule })
  .refine(validGroupCursor, { message: groupCursorRule })
  .refine((v) => v.groupBy !== "day" || !!(v.from && v.to), {
    message: groupRangeRule,
  });
export type ChatMessageQuery = z.infer<typeof chatMessageQuerySchema>;
export type ChatCountQuery = z.infer<typeof chatCountQuerySchema>;
export type ChatExtremaQuery = z.infer<typeof chatExtremaQuerySchema>;
export type ChatArchiveQuery =
  ChatMessageQuery | ChatCountQuery | ChatExtremaQuery;
export interface MessagePosition {
  sentAt: string;
  index: string;
}
export interface CountPosition {
  key: string;
  count: number;
}
export type ChatPosition = MessagePosition | CountPosition | string;
export function chatTimeZone(value: string | undefined): string {
  const zone = value ?? "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
  } catch {
    throw new ChatQueryError("invalid-chat-timezone");
  }
  return zone;
}
export function localDate(timestamp: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  return ["year", "month", "day"]
    .map((type) => parts.find((p) => p.type === type)?.value)
    .join("-");
}
export function dayBounds(
  query: ChatFilters,
  timeZone: string,
): [string, string] {
  if (!query.from || !query.to) throw new ChatQueryError("day-range-required");
  const first = localDate(query.from, timeZone),
    last = localDate(query.to, timeZone);
  const length =
    (Date.parse(last + "T00:00:00Z") - Date.parse(first + "T00:00:00Z")) /
      86400000 +
    1;
  if (!Number.isFinite(length) || length < 1 || length > 366)
    throw new ChatQueryError("day-range-too-large");
  return [first, last];
}
export function appliedFilters(query: ChatArchiveQuery): ChatFilters {
  const {
    senderId,
    botWorkflowId,
    from,
    to,
    dailyTime,
    keywords,
    keywordMode,
  } = query;
  return {
    senderId,
    botWorkflowId,
    from,
    to,
    dailyTime,
    keywords,
    keywordMode,
    authorKind: "authorKind" in query ? query.authorKind : undefined,
    ...(!("pick" in query)
      ? {
          hasAttachments: query.hasAttachments,
          attachmentName: query.attachmentName,
          attachmentType: query.attachmentType,
          attachmentOffset:
            "order" in query ? query.attachmentOffset : undefined,
        }
      : {}),
  };
}
