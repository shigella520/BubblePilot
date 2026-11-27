import { describe, expect, it } from "vitest";
import {
  keywordCondition,
  trigramUsable,
} from "../modules/archive/keyword-match.js";

describe("keyword match form", () => {
  it("uses the trigram index only when every keyword has three characters", () => {
    expect(trigramUsable(["周报"])).toBe(false);
    expect(trigramUsable(["业委会"])).toBe(true);
    expect(trigramUsable(["炖牛腩", "备份"])).toBe(false);
    expect(trigramUsable(["gemini", "opensandbox"])).toBe(true);
    expect(trigramUsable(["ab"])).toBe(false);
    // Emoji and other astral characters count as one character each.
    expect(trigramUsable(["😀😀"])).toBe(false);
    expect(trigramUsable([])).toBe(false);
  });
  it("escapes LIKE wildcards in the index form and keeps the plain form literal", () => {
    expect(keywordCondition("$2", true)).toContain("ESCAPE '\\'");
    expect(keywordCondition("$2", true)).toContain(
      "m.content_redacted_at IS NULL",
    );
    expect(keywordCondition("$2", false)).toBe(
      "strpos(lower(coalesce(m.body,'')),lower($2::text))>0",
    );
  });
});
