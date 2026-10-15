import { describe, expect, it } from "vitest";
import { pageScrollPosition } from "../apps/web/src/utils/scroll-policy.js";

describe("page scroll ownership", () => {
  it("keeps filters and detail changes at the current scroll position", () => {
    expect(
      pageScrollPosition(
        { path: "/memes", hash: "" },
        { path: "/memes" },
        null,
      ),
    ).toBe(false);
  });
  it("resets scroll when entering another page", () => {
    expect(
      pageScrollPosition(
        { path: "/ai", hash: "" },
        { path: "/messages" },
        null,
      ),
    ).toEqual({ top: 0, left: 0 });
  });
  it("lets module navigation resolve anchors after rendering", () => {
    expect(
      pageScrollPosition(
        { path: "/ai", hash: "#providers" },
        { path: "/messages" },
        null,
      ),
    ).toBe(false);
  });
  it("restores the browser's position on back and forward navigation", () => {
    expect(
      pageScrollPosition(
        { path: "/ai", hash: "#providers" },
        { path: "/messages" },
        { top: 640, left: 0 },
      ),
    ).toEqual({ top: 640, left: 0 });
  });
});
