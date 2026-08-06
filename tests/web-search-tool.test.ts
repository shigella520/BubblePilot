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
              publishedDate: null,
              engine: "fictional",
            },
            { title: "Unsafe", url: "javascript:alert(1)" },
            { title: null, url: null, content: null, engine: null },
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
        language: "zh-CN",
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
    expect(requestUrl.searchParams.get("language")).toBe("zh-CN");
    expect(requestUrl.searchParams.get("safesearch")).toBe("1");
  });

  it("returns a no-results outcome while preserving partial engine failures", async () => {
    const tool = new SearxngWebSearchTool(
      { baseUrl: "https://search.example.test", language: "zh-CN" },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [],
            unresponsive_engines: [
              ["baidu", "Suspended: CAPTCHA"],
              ["duckduckgo", "CAPTCHA"],
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(tool.search("卢本伟的最新资讯")).resolves.toMatchObject({
      results: [],
      requestDetails: {
        query: "卢本伟的最新资讯",
        language: "zh-CN",
      },
      responseDetails: {
        outcome: "no_results",
        retainedResultCount: 0,
        engineFailures: [
          { engine: "baidu", reason: "Suspended: CAPTCHA" },
          { engine: "duckduckgo", reason: "CAPTCHA" },
        ],
      },
    });
  });

  it("relaxes a site query once and keeps only results from that domain", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [],
            unresponsive_engines: [["baidu", "CAPTCHA"]],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Official product",
                url: "https://www.segway.com.cn/product/n1",
                content: "Official details",
                engine: "yandex",
              },
              {
                title: "Third-party article",
                url: "https://news.example.test/segway-n1",
                content: "External details",
                engine: "yandex",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const tool = new SearxngWebSearchTool(
      { baseUrl: "https://search.example.test", language: "zh-CN" },
      fetchImplementation,
    );

    await expect(
      tool.search("site:segway.com.cn 九号 2026 新品 N1 M1 M3 F25 电动车"),
    ).resolves.toMatchObject({
      results: [
        {
          title: "Official product",
          url: "https://www.segway.com.cn/product/n1",
        },
      ],
      requestDetails: {
        siteConstraint: "segway.com.cn",
        queryStrategy: "site-with-relaxed-fallback",
        relaxedQuery: "九号 2026 新品 N1 M1 M3 F25 电动车 segway.com.cn",
      },
      responseDetails: {
        outcome: "results",
        retainedResultCount: 1,
        attempts: [
          {
            strategy: "exact",
            rawResultCount: 0,
            matchingResultCount: 0,
          },
          {
            strategy: "relaxed-site",
            rawResultCount: 2,
            matchingResultCount: 1,
          },
        ],
        engineFailures: [{ engine: "baidu", reason: "CAPTCHA" }],
      },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const exactUrl = fetchImplementation.mock.calls[0]?.[0];
    const relaxedUrl = fetchImplementation.mock.calls[1]?.[0];
    expect(exactUrl).toBeInstanceOf(URL);
    expect(relaxedUrl).toBeInstanceOf(URL);
    if (!(relaxedUrl instanceof URL))
      throw new Error("Expected the relaxed request URL.");
    expect(relaxedUrl.searchParams.get("q")).toBe(
      "九号 2026 新品 N1 M1 M3 F25 电动车 segway.com.cn",
    );
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
      responseDetails: {
        httpStatus: 200,
        schemaIssues: [
          {
            path: "results",
            code: "invalid_type",
          },
        ],
      },
    });
  });

  it("classifies invalid JSON as an invalid response", async () => {
    const tool = new SearxngWebSearchTool(
      { baseUrl: "https://search.example.test" },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("not-json", { status: 200 })),
    );

    await expect(tool.search("fictional")).rejects.toMatchObject({
      code: "AI_WEB_SEARCH_INVALID_RESPONSE",
      responseDetails: { httpStatus: 200, jsonParseFailed: true },
    });
  });

  it("checks backend readiness without depending on a search engine result", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("OK", { status: 200 }));
    const tool = new SearxngWebSearchTool(
      { baseUrl: "https://search.example.test" },
      fetchImplementation,
    );

    await expect(tool.isReady()).resolves.toBe(true);
    const requestUrl = fetchImplementation.mock.calls.at(0)?.at(0);
    expect(requestUrl).toEqual(new URL("https://search.example.test/healthz"));
  });

  it("reports unavailable when the backend health endpoint fails", async () => {
    const tool = new SearxngWebSearchTool(
      { baseUrl: "https://search.example.test" },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("unavailable", { status: 503 })),
    );

    await expect(tool.isReady()).resolves.toBe(false);
  });
});
