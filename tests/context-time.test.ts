import { describe, expect, it } from "vitest";

import {
  formatContextTimestamp,
  isValidTimeZone,
  runtimeTimeZone,
} from "../modules/workflow/context-time.js";

describe("workflow context time", () => {
  it("formats UTC timestamps in the configured IANA time zone", () => {
    expect(
      formatContextTimestamp("2026-08-10T00:00:01.000Z", "Asia/Shanghai"),
    ).toBe("2026-08-10 08:00:01 GMT+08:00 [Asia/Shanghai]");
  });

  it("uses the actual daylight-saving offset for the message instant", () => {
    expect(
      formatContextTimestamp("2026-07-10T12:00:00.000Z", "America/New_York"),
    ).toContain("08:00:00 GMT-04:00 [America/New_York]");
    expect(
      formatContextTimestamp("2026-01-10T12:00:00.000Z", "America/New_York"),
    ).toContain("07:00:00 GMT-05:00 [America/New_York]");
  });

  it("recognizes valid IANA zones", () => {
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("Fictional/Invalid")).toBe(false);
    expect(isValidTimeZone(runtimeTimeZone())).toBe(true);
  });

  it("does not convert an already formatted context timestamp twice", () => {
    const formatted = "2026-08-10 08:00:01 GMT+08:00 [Asia/Shanghai]";
    expect(formatContextTimestamp(formatted, "Asia/Shanghai")).toBe(formatted);
  });
});
