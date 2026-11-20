import { describe, expect, it } from "vitest";
import {
  pageScrollPosition,
  sectionIndexAtScroll,
} from "../apps/web/src/utils/scroll-policy.js";

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

describe("section navigation at the page boundary", () => {
  const sections = [
    { id: "executions", top: 300 },
    { id: "memory-jobs", top: 900 },
    { id: "audit", top: 900 },
  ];
  it("keeps the clicked history section selected when audit shares the scroll boundary", () => {
    expect(sectionIndexAtScroll(sections, 900, 900, "memory-jobs")).toBe(1);
    expect(sectionIndexAtScroll(sections, 900, 900, "audit")).toBe(2);
  });
  it("returns to scroll-based selection after the user releases the anchor", () => {
    expect(sectionIndexAtScroll(sections, 900, 900, "")).toBe(2);
    expect(sectionIndexAtScroll(sections, 450, 900, "")).toBe(0);
  });
  it("does not jump the indicator to an anchor before a smooth scroll arrives", () => {
    expect(sectionIndexAtScroll(sections, 450, 900, "memory-jobs")).toBe(0);
  });
  it("supports explicit links even when all sections fit without scrolling", () => {
    expect(
      sectionIndexAtScroll(
        [
          { id: "memory-jobs", top: 0 },
          { id: "audit", top: 0 },
        ],
        0,
        0,
        "audit",
      ),
    ).toBe(1);
  });
});
