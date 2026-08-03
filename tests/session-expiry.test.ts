import { describe, expect, it } from "vitest";

import {
  nextSessionDeadline,
  sessionTimeState,
} from "../apps/web/src/stores/session-expiry.js";

const observedAt = Date.parse("2026-08-03T12:00:00.000Z");
const session = {
  expiresAt: "2026-08-03T12:05:00.000Z",
  sensitiveUntil: "2026-08-03T12:01:00.000Z",
};

describe("web session expiry", () => {
  it("uses the sensitive grant as the first reactive deadline", () => {
    expect(nextSessionDeadline(session, observedAt)).toBe(
      Date.parse(session.sensitiveUntil),
    );
    expect(sessionTimeState(session, observedAt)).toEqual({
      authenticated: true,
      sensitiveActive: true,
    });
  });

  it("expires the grant before the containing admin session", () => {
    expect(
      sessionTimeState(session, Date.parse(session.sensitiveUntil)),
    ).toEqual({ authenticated: true, sensitiveActive: false });
    expect(
      sessionTimeState(session, Date.parse(session.sensitiveUntil) + 1),
    ).toEqual({ authenticated: true, sensitiveActive: false });
    expect(
      nextSessionDeadline(session, Date.parse(session.sensitiveUntil) + 1),
    ).toBe(Date.parse(session.expiresAt));
  });

  it("invalidates both states at session expiry", () => {
    expect(sessionTimeState(session, Date.parse(session.expiresAt))).toEqual({
      authenticated: false,
      sensitiveActive: false,
    });
    expect(nextSessionDeadline(session, Date.parse(session.expiresAt))).toBe(
      null,
    );
  });
});
