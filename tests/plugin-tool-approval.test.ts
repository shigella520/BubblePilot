import { describe, expect, it } from "vitest";
import { retainedApprovals } from "../apps/web/src/utils/plugin-tool-approval.js";

const tool = (name: string, hash: string) => ({
  server: "image-gen",
  hash,
  definition: { name },
});

describe("re-testing a plugin connection", () => {
  it("keeps unchanged approvals and requires review for changed or new tools", () => {
    const previous = ["image-gen/generate_image#a", "image-gen/edit_image#b"];
    expect(
      retainedApprovals(previous, [
        tool("generate_image", "a"),
        tool("edit_image", "b2"),
        tool("view_image", "c"),
      ]),
    ).toEqual(["image-gen/generate_image#a"]);
  });
  it("never revokes approvals when the definitions are identical", () => {
    const previous = ["image-gen/generate_image#a", "image-gen/edit_image#b"];
    expect(
      retainedApprovals(previous, [
        tool("generate_image", "a"),
        tool("edit_image", "b"),
      ]),
    ).toEqual(previous);
  });
});
