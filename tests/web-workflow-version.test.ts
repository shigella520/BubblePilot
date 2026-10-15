import { describe, expect, it } from "vitest";
import { selectWorkflowVersion } from "../apps/web/src/utils/workflow-version.js";

describe("workflow canvas and list export version selection", () => {
  const published = { version: 3, status: "published" };
  const oldCandidate = { version: 2, status: "validated" };
  const newCandidate = { version: 4, status: "validated" };
  it("exports the published canvas instead of a stale or newer candidate", () => {
    expect(
      selectWorkflowVersion([newCandidate, published, oldCandidate], 3),
    ).toBe(published);
  });
  it("preserves explicitly requested candidates in the canvas", () => {
    expect(selectWorkflowVersion([published, newCandidate], 3, 4)).toBe(
      newCandidate,
    );
  });
  it("uses the latest candidate when nothing has been published, regardless of response order", () => {
    expect(selectWorkflowVersion([oldCandidate, newCandidate], null)).toBe(
      newCandidate,
    );
    expect(selectWorkflowVersion([], null)).toBeUndefined();
    expect(selectWorkflowVersion([published, newCandidate], 99)).toBe(
      newCandidate,
    );
  });
});
