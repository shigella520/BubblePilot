import { describe, expect, it } from "vitest";
import {
  idleTriggerSchema,
  idleDueAt,
  idleDay,
  isQuiet,
  quietUntil,
  parseIdleDecision,
} from "../modules/workflow/idle-policy.js";
import { parseWorkflowDefinition } from "../modules/workflow/workflow-definition.js";
const config = idleTriggerSchema.parse({
  enabled: true,
  chatIds: ["fictional-chat"],
  timeZone: "Asia/Shanghai",
});
describe("idle policy", () => {
  it("defaults to the original neutral instruction and preserves custom configuration", () => {
    expect(config.taskInstruction).toBe(
      "结合角色与已有聊天，自然、简短地主动交流。没有合适内容时保持安静；不重复回答历史问题，不制造紧迫感，不连续追问，也不宣称用户刚刚提出了新要求。",
    );
    expect(
      idleTriggerSchema.parse({
        timeZone: "UTC",
        taskInstruction: "自定义虚构交流说明",
      }).taskInstruction,
    ).toBe("自定义虚构交流说明");
    for (const taskInstruction of ["", " ", "字".repeat(4001)])
      expect(() =>
        idleTriggerSchema.parse({ timeZone: "UTC", taskInstruction }),
      ).toThrow();
  });
  it("requires explicit chats and a valid time zone", () => {
    expect(() =>
      idleTriggerSchema.parse({ enabled: true, timeZone: "Asia/Shanghai" }),
    ).toThrow();
    expect(() =>
      idleTriggerSchema.parse({ timeZone: "invalid/zone" }),
    ).toThrow();
    expect(() =>
      idleTriggerSchema.parse({ timeZone: "UTC", idleMinutes: 1 }),
    ).toThrow();
  });
  it("accepts new bounds and rejects out-of-range or fractional limits", () => {
    for (const idleMinutes of [2, 360])
      for (const dailyLimit of [2, 666]) {
        expect(
          idleTriggerSchema.parse({ timeZone: "UTC", idleMinutes, dailyLimit }),
        ).toMatchObject({ idleMinutes, dailyLimit });
      }
    for (const idleMinutes of [1, 361, 2.5])
      expect(() =>
        idleTriggerSchema.parse({ timeZone: "UTC", idleMinutes }),
      ).toThrow();
    for (const dailyLimit of [1, 667, 2.5])
      expect(() =>
        idleTriggerSchema.parse({ timeZone: "UTC", dailyLimit }),
      ).toThrow();
  });
  it("uses inclusive start and exclusive end across midnight", () => {
    expect(isQuiet(new Date("2026-11-02T15:00:00Z"), config)).toBe(true);
    expect(isQuiet(new Date("2026-11-03T00:59:59Z"), config)).toBe(true);
    expect(isQuiet(new Date("2026-11-03T01:00:00Z"), config)).toBe(false);
    expect(
      idleDueAt(new Date("2026-11-02T14:30:00Z"), config)?.toISOString(),
    ).toBe("2026-11-03T02:00:00.000Z");
  });
  it("does not catch up an old greeting after downtime spanning quiet hours", () => {
    expect(
      idleDueAt(
        new Date("2026-11-02T06:00:00Z"),
        config,
        new Date("2026-11-03T01:05:00Z"),
      )?.toISOString(),
    ).toBe("2026-11-03T02:00:00.000Z");
  });
  it("takes the start weekday and unions overlapping periods", () => {
    const monday = {
      ...config,
      quietPeriods: [
        { days: [1], start: "23:00", end: "09:00" },
        { days: [2], start: "08:00", end: "10:00" },
      ],
    };
    expect(
      quietUntil(new Date("2026-11-02T15:00:00Z"), monday)?.toISOString(),
    ).toBe("2026-11-03T02:00:00.000Z");
    expect(isQuiet(new Date("2026-11-01T23:00:00Z"), monday)).toBe(false);
  });
  it("handles DST repeated clocks and local daily boundaries", () => {
    const dst = {
      ...config,
      timeZone: "America/New_York",
      quietPeriods: [{ days: [7], start: "01:00", end: "03:00" }],
    };
    expect(
      quietUntil(new Date("2026-11-01T05:30:00Z"), dst)?.toISOString(),
    ).toBe("2026-11-01T08:00:00.000Z");
    expect(idleDay(new Date("2026-11-02T00:30:00Z"), dst.timeZone)).toBe(
      "2026-11-01",
    );
  });
  it("fails closed for a fully quiet week", () => {
    const all = {
      ...config,
      quietPeriods: [
        { days: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "12:00" },
        { days: [1, 2, 3, 4, 5, 6, 7], start: "12:00", end: "00:00" },
      ],
    };
    expect(quietUntil(new Date("2026-11-02T00:00:00Z"), all)).toBeNull();
  });
  it("uses an explicit decision rather than natural language or partial JSON", () => {
    expect(parseIdleDecision('{"action":"skip"}')).toEqual({ action: "skip" });
    expect(
      parseIdleDecision('{"action":"skip","reason":"repetitive"}'),
    ).toEqual({ action: "skip", reason: "repetitive" });
    expect(() =>
      parseIdleDecision('{"action":"skip","reason":"free-form reasoning"}'),
    ).toThrow();
    expect(parseIdleDecision('{"action":"send","text":"你好"}')).toEqual({
      action: "send",
      text: "你好",
    });
    for (const value of [
      "无需回复",
      '{"action":"send","text":" "}',
      '{"action":"skip","text":"oops"}',
      "```json\n{}\n```",
    ])
      expect(() => parseIdleDecision(value)).toThrow();
  });
});
const definition = () => ({
  schemaVersion: "1",
  name: "Fictional idle",
  startNodeId: "message-trigger",
  nodes: [
    {
      id: "message-trigger",
      type: "message-trigger",
      version: 1,
      config: { idle: config },
      onSuccess: "ai",
    },
    {
      id: "ai",
      type: "ai-chat",
      version: 1,
      config: {
        providerRouteId: "00000000-0000-4000-8000-000000000001",
        systemPrompt: "Fictional role",
        promptTemplate: "Respond naturally",
        outputVariable: "answer",
        outputFormat: "text",
      },
      onSuccess: "reply",
    },
    {
      id: "reply",
      type: "reply",
      version: 1,
      config: { text: "{{variables.answer}}" },
      onSuccess: "end",
    },
    { id: "end", type: "end", version: 1, config: {} },
  ],
});
describe("idle workflow validation", () => {
  it("accepts the existing AI chain without duplicating a role", () => {
    expect(() => parseWorkflowDefinition(definition())).not.toThrow();
  });
  it("accepts direct current-text AI input but rejects other current-message dependencies", () => {
    const input = definition();
    Object.assign(input.nodes[1]!, {
      inputs: { prompt: { kind: "path", path: "context.event.message.text" } },
    });
    expect(() => parseWorkflowDefinition(input)).not.toThrow();
    Object.assign(input.nodes[1]!, {
      inputs: {
        prompt: { kind: "path", path: "context.event.message.senderId" },
      },
    });
    expect(() => parseWorkflowDefinition(input)).toThrow(/current message/);
  });
  it("rejects current message templates and reply paths bypassing AI", () => {
    const input = definition();
    Object.assign(input.nodes[1]!.config, {
      promptTemplate: "{{message.text}}",
    });
    expect(() => parseWorkflowDefinition(input)).toThrow(/current message/);
    const bypass = definition();
    bypass.nodes.splice(1, 1);
    bypass.nodes[0]!.onSuccess = "reply";
    Object.assign(bypass.nodes[1]!.config, { text: "hello" });
    expect(() => parseWorkflowDefinition(bypass)).toThrow(/AI send decision/);
  });
  it("keeps disabled old workflows compatible", () => {
    const input = definition();
    Object.assign(input.nodes[0]!.config, {
      idle: { ...config, enabled: false },
    });
    Object.assign(input.nodes[1]!.config, {
      promptTemplate: "{{message.text}}",
    });
    expect(() => parseWorkflowDefinition(input)).not.toThrow();
  });
});
