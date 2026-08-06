import { describe, expect, it, vi } from "vitest";

import { SearxngWebSearchTool } from "../modules/ai/web-search-tool.js";

describe("SearxngWebSearchTool", () => {
  it("normalizes safe JSON results and drops unsafe URLs", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "<b>Fresh</b> result",
              url: "https://news.example.test/item",
              content: "<script>ignore()</script> Current summary",
              engine: "fictional",
            },
            { title: "Unsafe", url: "javascript:alert(1)" },
          ],
        }),
        { status: 200 },
      ),
    );
    const tool = new SearxngWebSearchTool(
      {
        baseUrl: "https://search.example.test",
        maxResults: 5,
        engines: ["baidu"],
      },
      fetchImplementation,
    );
    await expect(tool.search(" fictional query ")).resolves.toMatchObject({
      results: [
        {
          title: "Fresh result",
          url: "https://news.example.test/item",
          source: "fictional",
        },
      ],
    });
    const requestUrl = fetchImplementation.mock.calls.at(0)?.at(0);
    expect(requestUrl).toBeInstanceOf(URL);
    if (!(requestUrl instanceof URL))
      throw new Error("Expected a URL request.");
    expect(requestUrl.searchParams.get("engines")).toBe("baidu");
  });

  it("returns stable errors for invalid responses", async () => {
    const tool = new SearxngWebSearchTool(
      { baseUrl: "https://search.example.test" },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ invalid: true }), { status: 200 }),
        ),
    );
    await expect(tool.search("fictional")).rejects.toMatchObject({
      code: "AI_WEB_SEARCH_INVALID_RESPONSE",
    });
  });

  it("reports ready when the search endpoint returns valid empty results", async () => {
    const tool = new SearxngWebSearchTool(
      { baseUrl: "https://search.example.test" },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ results: [] }), { status: 200 }),
        ),
    );

    await expect(tool.isReady()).resolves.toBe(true);
  });
});
