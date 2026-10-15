import { it, expect } from "vitest";
import { memeDiagnostics } from "../modules/memes/meme-diagnostics.js";
import { memeToolLabel } from "../apps/web/src/utils/meme-tool-diagnostics.js";
const id = "11111111-1111-4111-8111-111111111111";
it("records only accepted whitelist metadata, preserving search and selection semantics", () => {
  const found = memeDiagnostics(
    "search_memes",
    '{"query":"虚构秘密 开心 开心","limit":5}',
    JSON.stringify({
      status: "ok",
      results: [{ id, summary: "不得记录的摘要" }],
      truncated: true,
    }),
    null,
    false,
  );
  expect(found).toMatchObject({
    requestDetails: {
      version: 1,
      mode: "keywords",
      keywordCount: 2,
      requestedLimit: 5,
    },
    responseDetails: { outcome: "ok", returnedCount: 1, truncated: true },
    resultCount: 1,
    errorCode: null,
  });
  expect(JSON.stringify(found)).not.toContain("虚构秘密");
  expect(JSON.stringify(found)).not.toContain("不得记录");
  expect(memeToolLabel("search_memes", found.responseDetails)).toBe(
    "找到 1 张候选 · 候选已截断",
  );
  const empty = memeDiagnostics(
    "search_memes",
    '{"query":""}',
    '{"status":"no-results","results":[],"truncated":false}',
    null,
    false,
  );
  expect(empty).toMatchObject({
    requestDetails: { mode: "browse", keywordCount: 0 },
    resultCount: 0,
    errorCode: null,
  });
  for (const value of [id, null]) {
    const result = memeDiagnostics(
      "select_meme",
      JSON.stringify({ id: value }),
      JSON.stringify({ status: "selected", id: value, sent: false }),
      null,
      false,
    );
    expect(result.resultCount).toBeNull();
    expect(result.errorCode).toBeNull();
    expect(result.responseDetails.outcome).toBe(value ? "selected" : "cleared");
    expect(memeToolLabel("select_meme", result.responseDetails)).toBe(
      value ? "已选择，待发送" : "已清除选择",
    );
  }
  expect(memeToolLabel("select_meme", { outcome: "completed" })).toBe(
    "未记录详细结果",
  );
  expect(memeToolLabel("web_search", null)).toBeNull();
});
it.each([
  [
    "invalid-selection",
    "not-a-returned-candidate",
    null,
    false,
    "invalid-selection",
    "MEME_INVALID_SELECTION",
  ],
  [
    "invalid-arguments",
    "private arbitrary text",
    null,
    false,
    "invalid-arguments",
    "AI_AGENT_INVALID_TOOL_ARGUMENTS",
  ],
  [
    "unavailable",
    "asset-unavailable",
    "MEME_TOOL_UNAVAILABLE",
    false,
    "unavailable",
    "MEME_TOOL_UNAVAILABLE",
  ],
  [
    "unavailable",
    "query-failed",
    "MEME_TOOL_UNAVAILABLE",
    false,
    "unavailable",
    "MEME_TOOL_UNAVAILABLE",
  ],
  [
    "unavailable",
    "tool-duration",
    "AI_AGENT_TOOL_TIMEOUT",
    false,
    "timeout",
    "AI_AGENT_TOOL_TIMEOUT",
  ],
  [
    "unavailable",
    "timeout",
    "MEME_TOOL_UNAVAILABLE",
    false,
    "timeout",
    "AI_AGENT_TOOL_TIMEOUT",
  ],
  [
    "unavailable",
    "content-budget",
    "MEME_TOOL_UNAVAILABLE",
    false,
    "budget-exhausted",
    "AI_AGENT_TOOL_LIMIT_REACHED",
  ],
  [
    "selected",
    null,
    "AI_AGENT_TOOL_LIMIT_REACHED",
    true,
    "budget-exhausted",
    "AI_AGENT_TOOL_LIMIT_REACHED",
  ],
] as const)(
  "classifies %s/%s without leaking rejected output",
  (status, reason, error, skipped, outcome, code) => {
    const result = memeDiagnostics(
      "select_meme",
      JSON.stringify({ id }),
      JSON.stringify({ status, ...(reason ? { reason } : {}), id }),
      error,
      skipped,
    );
    expect(result).toMatchObject({
      errorCode: code,
      resultCount: null,
      responseDetails: { outcome },
    });
    expect(result.responseDetails).not.toHaveProperty("selectedMemeId");
    expect(JSON.stringify(result)).not.toContain("private arbitrary text");
  },
);
