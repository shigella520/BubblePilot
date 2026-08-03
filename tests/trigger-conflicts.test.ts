import { describe, expect, it } from "vitest";

import {
  findPotentialTriggerConflicts,
  triggersCouldOverlap,
  type ConflictCandidate,
} from "../modules/workflow/trigger-conflicts.js";
import { parseTriggerConditions } from "../modules/workflow/trigger-matcher.js";

function candidate(
  id: string,
  conditions: Parameters<typeof parseTriggerConditions>[0],
  enabled = true,
): ConflictCandidate {
  return { id, enabled, conditions: parseTriggerConditions(conditions) };
}

describe("trigger conflict analysis", () => {
  it("reports broad and compatible enabled triggers in both directions", () => {
    const broad = candidate("broad", {
      text: { kind: "prefix", value: "/sum" },
    });
    const specific = candidate("specific", {
      chatIds: ["iMessage;-;fictional-conflict-chat"],
      text: { kind: "prefix", value: "/summary" },
    });
    const disabled = candidate(
      "disabled",
      { text: { kind: "prefix", value: "/sum" } },
      false,
    );

    const conflicts = findPotentialTriggerConflicts([
      broad,
      specific,
      disabled,
    ]);
    expect(conflicts.get("broad")).toEqual(["specific"]);
    expect(conflicts.get("specific")).toEqual(["broad"]);
    expect(conflicts.get("disabled")).toEqual([]);
  });

  it("eliminates candidates with provably disjoint dimensions", () => {
    const ping = candidate("ping", {
      chatIds: ["iMessage;-;fictional-chat-one"],
      contentTypes: ["text"],
      text: { kind: "prefix", value: "/ping" },
    });
    const help = candidate("help", {
      chatIds: ["iMessage;-;fictional-chat-two"],
      contentTypes: ["attachment"],
      text: { kind: "prefix", value: "/help" },
    });

    expect(triggersCouldOverlap(ping, help)).toBe(false);
  });

  it("uses end-exclusive weekly intervals for same-zone time windows", () => {
    const morning = candidate("morning", {
      timeWindow: {
        timeZone: "Asia/Shanghai",
        daysOfWeek: ["monday"],
        start: "09:00",
        end: "10:00",
      },
    });
    const daytime = candidate("daytime", {
      timeWindow: {
        timeZone: "Asia/Shanghai",
        daysOfWeek: ["monday"],
        start: "10:00",
        end: "11:00",
      },
    });
    const overnight = candidate("overnight", {
      timeWindow: {
        timeZone: "Asia/Shanghai",
        daysOfWeek: ["monday"],
        start: "22:00",
        end: "02:00",
      },
    });
    const earlyTuesday = candidate("early-tuesday", {
      timeWindow: {
        timeZone: "Asia/Shanghai",
        daysOfWeek: ["tuesday"],
        start: "01:00",
        end: "03:00",
      },
    });

    expect(triggersCouldOverlap(morning, daytime)).toBe(false);
    expect(triggersCouldOverlap(overnight, earlyTuesday)).toBe(true);
  });
});
