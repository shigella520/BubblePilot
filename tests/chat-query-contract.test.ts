import { describe, expect, it } from "vitest";
import {
  chatMessageQuerySchema,
  chatCountQuerySchema,
  chatExtremaQuerySchema,
  dayBounds,
  localDate,
} from "../modules/memory/chat-query-types.js";
import { memoryTools } from "../modules/memory/memory-service.js";
import { fitToolOutput } from "../modules/ai/agent-budget.js";

describe("archive tool contracts", () => {
  it("exposes exactly five focused tools with server-owned scope", () => {
    expect(memoryTools.map((t) => t.name).sort()).toEqual(
      [
        "query_chat_messages",
        "count_chat_messages",
        "get_chat_message_extrema",
        "search_chat_history",
        "read_chat_excerpt",
      ].sort(),
    );
    expect(chatMessageQuerySchema.parse({})).toEqual({
      order: "desc",
      limit: 20,
    });
    expect(chatCountQuerySchema.parse({})).toEqual({
      groupBy: "none",
      limit: 31,
    });
    expect(chatExtremaQuerySchema.safeParse({}).success).toBe(false);
    for (const value of [
      { chatId: "other" },
      { timeZone: "UTC" },
      { upperIndex: 999 },
      { limit: 51 },
      { limit: 0 },
      { cursor: "forged" },
      { from: "2026-01-01T00:00:00" },
      {
        from: "2026-01-01T00:00:00.000002Z",
        to: "2026-01-01T00:00:00.000001Z",
      },
      { from: "2026-01-01T00:00:00.0000001Z" },
      { from: "2026-01-02T00:00:00Z", to: "2026-01-01T00:00:00Z" },
      { keywords: ["word"] },
      { keywordMode: "all" },
      { keywords: [" "], keywordMode: "any" },
      { dailyTime: { from: "24:00", to: "06:00" } },
      { dailyTime: { from: "6:00", to: "24:00" } },
      { dailyTime: { from: "06:00", to: "06:00" } },
    ])
      expect(
        chatMessageQuerySchema.safeParse(value).success,
        JSON.stringify(value),
      ).toBe(false);
    expect(
      chatMessageQuerySchema.safeParse({
        dailyTime: { from: "23:00", to: "02:00" },
      }).success,
    ).toBe(true);
    expect(
      chatMessageQuerySchema.safeParse({
        dailyTime: { from: "00:00", to: "24:00" },
      }).success,
    ).toBe(true);
  });
  it("bounds local day enumeration and preserves exact local dates across DST", () => {
    expect(chatCountQuerySchema.safeParse({ groupBy: "day" }).success).toBe(
      false,
    );
    expect(
      dayBounds(
        chatCountQuerySchema.parse({
          groupBy: "day",
          from: "2026-11-01T00:00:00-04:00",
          to: "2026-11-02T00:00:00-05:00",
        }),
        "America/New_York",
      ),
    ).toEqual(["2026-11-01", "2026-11-02"]);
    expect(localDate("2026-09-10T16:00:00Z", "Asia/Shanghai")).toBe(
      "2026-09-11",
    );
    expect(() =>
      dayBounds(
        chatCountQuerySchema.parse({
          groupBy: "day",
          from: "2025-01-01T00:00:00Z",
          to: "2026-01-02T00:00:00Z",
        }),
        "UTC",
      ),
    ).toThrow("day-range-too-large");
  });
  it("never trims a serialized page while retaining a stale cursor", () => {
    expect(
      fitToolOutput(
        JSON.stringify({
          evidence: [{ text: "x".repeat(200) }],
          nextCursor: "opaque",
        }),
        100,
      ),
    ).toEqual({ content: null, truncated: true });
  });
});
