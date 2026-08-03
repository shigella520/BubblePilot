import { describe, expect, it } from "vitest";

import type { MessageEnvelope } from "../modules/ingestion/message-envelope.js";
import {
  matchTrigger,
  parseTriggerConditions,
} from "../modules/workflow/trigger-matcher.js";

function envelope(sentAt: string): MessageEnvelope {
  return {
    schemaVersion: "1",
    eventId: "new-message:fictional-time-window-message",
    correlationId: "00000000-0000-4000-8000-000000000901",
    provider: "bluebubbles",
    chat: {
      providerChatId: "iMessage;-;fictional-time-window-chat",
      type: "direct",
      displayName: "Fictional Time Window Chat",
    },
    message: {
      providerMessageId: "fictional-time-window-message",
      senderId: "fictional-user@example.test",
      sentAt,
      text: "/schedule fictional task",
      contentType: "text",
      isFromMe: false,
      attachments: [],
      contentHash: `sha256:${"0".repeat(64)}`,
    },
    metadata: {
      isReplay: false,
      payloadHash: `sha256:${"0".repeat(64)}`,
      eventType: "new-message",
      adapterVersion: "test",
    },
  };
}

describe("trigger time windows", () => {
  it("matches the message instant in the configured IANA time zone", () => {
    const conditions = parseTriggerConditions({
      timeWindow: {
        timeZone: "Asia/Shanghai",
        daysOfWeek: ["monday"],
        start: "09:00",
        end: "18:00",
      },
    });

    const matching = matchTrigger(
      envelope("2026-08-03T02:30:00.000Z"),
      conditions,
      false,
    );
    expect(matching.matched).toBe(true);
    expect(
      matching.checks.find((check) => check.field === "timeWindow"),
    ).toEqual({ field: "timeWindow", matched: true });

    const outside = matchTrigger(
      envelope("2026-08-03T10:00:00.000Z"),
      conditions,
      false,
    );
    expect(outside.matched).toBe(false);
    expect(
      outside.checks.find((check) => check.field === "timeWindow"),
    ).toEqual({ field: "timeWindow", matched: false });
  });

  it("treats weekdays as the starting day for a cross-midnight window", () => {
    const conditions = parseTriggerConditions({
      timeWindow: {
        timeZone: "Asia/Shanghai",
        daysOfWeek: ["monday"],
        start: "22:00",
        end: "02:00",
      },
    });

    expect(
      matchTrigger(envelope("2026-08-03T15:30:00.000Z"), conditions, false)
        .matched,
    ).toBe(true);
    expect(
      matchTrigger(envelope("2026-08-03T17:00:00.000Z"), conditions, false)
        .matched,
    ).toBe(true);
    expect(
      matchTrigger(envelope("2026-08-04T15:30:00.000Z"), conditions, false)
        .matched,
    ).toBe(false);
  });

  it("rejects ambiguous windows and invalid time zones", () => {
    expect(() =>
      parseTriggerConditions({
        timeWindow: {
          timeZone: "Asia/Shanghai",
          daysOfWeek: ["monday"],
          start: "09:00",
          end: "09:00",
        },
      }),
    ).toThrow(/start and end must differ/u);
    expect(() =>
      parseTriggerConditions({
        timeWindow: {
          timeZone: "Fictional/Invalid",
          daysOfWeek: ["monday"],
          start: "09:00",
          end: "18:00",
        },
      }),
    ).toThrow(/invalid IANA time zone/u);
  });
});
