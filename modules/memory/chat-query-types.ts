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
  .refine((value) => (value.match(/\.(\d+)/u)?.[1]?.length ?? 0) <= 6);
function instantMicros(value: string): bigint {
  if (!Number.isFinite(Date.parse(value))) return 0n;
  const fraction = value.match(/\.(\d+)/u)?.[1] ?? "";
  return (
    BigInt(Date.parse(value)) * 1000n +
    BigInt(fraction.padEnd(6, "0").slice(3, 6))
  );
}
const fields = {
  botWorkflowId: z.string().uuid().optional(),
  senderId: z.string().trim().min(1).max(255).optional(),
  from: timestamp.optional(),
  to: timestamp.optional(),
  dailyTime: z
    .object({ from: timeOfDay, to: z.union([timeOfDay, z.literal("24:00")]) })
    .strict()
    .refine((v) => v.from !== v.to)
    .optional(),
  keywords: z
    .array(z.string().trim().min(1).max(100))
    .min(1)
    .max(10)
    .optional(),
  keywordMode: z.enum(["all", "any"]).optional(),
};
function validFilter(v: ChatFilters) {
  return (
    !(v.senderId && v.botWorkflowId) &&
    (!v.from || !v.to || instantMicros(v.from) <= instantMicros(v.to)) &&
    (v.keywords !== undefined) === (v.keywordMode !== undefined)
  );
}
export interface ChatFilters {
  senderId?: string | undefined;
  botWorkflowId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  dailyTime?: { from: string; to: string } | undefined;
  keywords?: string[] | undefined;
  keywordMode?: "all" | "any" | undefined;
}
const cursor = z.string().uuid().optional();
export const chatMessageQuerySchema = z
  .object({
    ...fields,
    order: z.enum(["asc", "desc"]).default("desc"),
    limit: z.number().int().min(1).max(50).default(20),
    cursor,
  })
  .strict()
  .refine(validFilter);
const groupFields = {
  ...fields,
  groupBy: z.enum(["none", "day", "sender"]).default("none"),
  limit: z.number().int().min(1).max(100).default(31),
  cursor,
};
function validGrouping(
  v: ChatFilters & { groupBy: string; cursor?: string | undefined },
) {
  return (
    validFilter(v) &&
    (v.groupBy !== "day" || !!(v.from && v.to)) &&
    (v.groupBy !== "none" || !v.cursor)
  );
}
export const chatCountQuerySchema = z
  .object(groupFields)
  .strict()
  .refine(validGrouping);
export const chatExtremaQuerySchema = z
  .object({ ...groupFields, pick: z.enum(["first", "last"]) })
  .strict()
  .refine(validGrouping);
export type ChatMessageQuery = z.infer<typeof chatMessageQuerySchema>;
export type ChatCountQuery = z.infer<typeof chatCountQuerySchema>;
export type ChatExtremaQuery = z.infer<typeof chatExtremaQuerySchema>;
export type ChatArchiveQuery =
  ChatMessageQuery | ChatCountQuery | ChatExtremaQuery;
export interface MessagePosition {
  sentAt: string;
  index: string;
}
export type ChatPosition = MessagePosition | string;
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
  query: ChatCountQuery,
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
  };
}
