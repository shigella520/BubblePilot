import { describe, expect, it } from "vitest";
import {
  chatCountQuerySchema,
  chatExtremaQuerySchema,
} from "../modules/memory/chat-query-types.js";
import { countBuckets } from "../modules/memory/chat-count-buckets.js";
import { chatCountDiagnostics } from "../modules/memory/chat-count-diagnostics.js";
import { memoryTools } from "../modules/memory/memory-service.js";
import {
  strictToolParameters,
  restoreToolArguments,
} from "../modules/ai/tool-schema.js";

const range = {
  from: "2026-11-07T00:00:00+08:00",
  to: "2026-11-07T23:59:59.999999+08:00",
};
const buckets = (
  groupBy: string,
  from = range.from,
  to = range.to,
  zone = "Asia/Shanghai",
) => countBuckets(chatCountQuerySchema.parse({ groupBy, from, to }), zone);
describe("chat counting dimensions", () => {
  it("allows only finite group combinations and retains old defaults", () => {
    expect(chatCountQuerySchema.parse({})).toEqual({
      groupBy: "none",
      limit: 31,
    });
    for (const groupBy of [
      "hour",
      "day",
      "week",
      "month",
      "hourOfDay",
      "weekday",
    ]) {
      expect(
        chatCountQuerySchema.safeParse({
          ...range,
          groupBy,
          breakdownBy: "sender",
        }).success,
      ).toBe(true);
      expect(chatCountQuerySchema.safeParse({ groupBy }).success).toBe(false);
    }
    expect(
      chatCountQuerySchema.safeParse({
        ...range,
        groupBy: "weekday",
        breakdownBy: "hourOfDay",
      }).success,
    ).toBe(true);
    for (const input of [
      { groupBy: "sender", breakdownBy: "sender" },
      { groupBy: "none", breakdownBy: "sender" },
      { groupBy: "hour", breakdownBy: "hourOfDay" },
      { groupBy: "month", breakdownBy: "weekday" },
      { groupBy: ["day", "sender"] },
      { orderBy: "random" },
      { authorKind: "human" },
      { hasAttachments: false, attachmentName: "report" },
      { hasAttachments: false, attachmentType: ".pdf" },
    ])
      expect(
        chatCountQuerySchema.safeParse({ ...range, ...input }).success,
      ).toBe(false);
    expect(
      chatExtremaQuerySchema.safeParse({
        ...range,
        pick: "first",
        groupBy: "hour",
      }).success,
    ).toBe(false);
  });
  it("converts strict wire parameters and restores optional nulls", () => {
    const tool = memoryTools.find((t) => t.name === "count_chat_messages")!;
    expect(() => strictToolParameters(tool)).not.toThrow();
    const restored: unknown = JSON.parse(
      restoreToolArguments(
        tool.parameters,
        JSON.stringify({
          ...range,
          groupBy: "hour",
          breakdownBy: null,
          orderBy: null,
          authorKind: null,
          hasAttachments: null,
        }),
      ),
    );
    expect(chatCountQuerySchema.parse(restored)).toEqual({
      ...range,
      groupBy: "hour",
      limit: 31,
    });
  });
  it("enumerates clock hours, ISO weekdays and complete calendar buckets", () => {
    const hourly = buckets("hour");
    expect(hourly).toHaveLength(24);
    expect(hourly[0]).toMatchObject({
      value: "2026-11-07T00:00:00+08:00",
      partialBucket: false,
    });
    expect(hourly.at(-1)?.partialBucket).toBe(false);
    expect(buckets("hourOfDay").map((b) => b.value)).toEqual(
      Array.from({ length: 24 }, (_, i) => i),
    );
    expect(buckets("weekday").map((b) => b.value)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(
      buckets(
        "week",
        "2025-12-31T12:00:00Z",
        "2026-01-05T00:00:00Z",
        "UTC",
      ).map((b) => b.value),
    ).toEqual(["2025-12-29", "2026-01-05"]);
    expect(
      buckets(
        "month",
        "2024-02-01T00:00:00Z",
        "2024-02-29T23:59:59.999999Z",
        "UTC",
      ),
    ).toMatchObject([
      {
        value: "2024-02",
        partialBucket: false,
        end: "2024-03-01T00:00:00+00:00",
      },
    ]);
    expect(
      buckets("day", "2026-11-07T08:00:00Z", "2026-11-07T13:00:00Z", "UTC")[0]
        ?.partialBucket,
    ).toBe(true);
    expect(() =>
      buckets("hourOfDay", "2020-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    ).toThrow("day-range-too-large");
  });
  it("separates repeated hours, skips nonexistent hours and handles partial-hour DST", () => {
    const fall = buckets(
      "hour",
      "2026-11-01T00:00:00-04:00",
      "2026-11-01T23:59:59.999999-05:00",
      "America/New_York",
    );
    expect(fall).toHaveLength(25);
    expect(fall.slice(1, 3).map((b) => b.value)).toEqual([
      "2026-11-01T01:00:00-04:00",
      "2026-11-01T01:00:00-05:00",
    ]);
    expect(new Set(fall.map((b) => b.key)).size).toBe(25);
    expect(
      buckets(
        "hour",
        "2026-03-08T00:00:00-05:00",
        "2026-03-08T23:59:59.999999-04:00",
        "America/New_York",
      ),
    ).toHaveLength(23);
    const half = buckets(
      "hour",
      "2026-10-04T00:00:00+10:30",
      "2026-10-04T23:59:59.999999+11:00",
      "Australia/Lord_Howe",
    );
    const backward = buckets(
      "hour",
      "2026-04-05T00:00:00+11:00",
      "2026-04-05T23:59:59.999999+10:30",
      "Australia/Lord_Howe",
    );
    expect(backward.slice(1, 3).map((b) => b.value)).toEqual([
      "2026-04-05T01:00:00+11:00",
      "2026-04-05T01:30:00+10:30",
    ]);
    expect(half[2]?.value).toBe("2026-10-04T02:30:00+11:00");
    expect(half.every((b, i) => !i || half[i - 1]?.end === b.start)).toBe(true);
  });
  it("keeps diagnostics free of filters, participant identities and result counts", () => {
    for (const content of ["null", "[]", "false", "123", '"string"']) {
      expect(() => chatCountDiagnostics("{}", content)).not.toThrow();
    }
    const metadata = chatCountDiagnostics(
      JSON.stringify({
        ...range,
        groupBy: "day",
        breakdownBy: "sender",
        keywords: ["private"],
        keywordMode: "all",
        senderId: "alice",
      }),
      JSON.stringify({
        groups: [{ count: 42, senderKey: "alice" }],
        hasMore: true,
        truncated: false,
      }),
    );
    expect(metadata).toMatchObject({
      groupBy: "day",
      breakdownBy: "sender",
      returnedGroupCount: 1,
      hasMore: true,
      truncated: false,
    });
    expect(JSON.stringify(metadata)).not.toMatch(/alice|private|2026|42/);
    expect(
      chatCountDiagnostics("invalid", '{"reason":"untrusted secret"}'),
    ).not.toHaveProperty("reason");
  });
});
