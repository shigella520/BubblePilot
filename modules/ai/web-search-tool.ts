import { z } from "zod";

const searxngResponseSchema = z.object({
  results: z.array(
    z
      .object({
        title: z.string().optional(),
        url: z.string(),
        content: z.string().optional(),
        publishedDate: z.string().optional(),
        engine: z.string().optional(),
      })
      .passthrough(),
  ),
});

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
  source: string | null;
}

export interface WebSearchToolResult {
  results: readonly WebSearchResult[];
  durationMs: number;
}

export interface WebSearchTool {
  isReady(): Promise<boolean>;
  search(query: string): Promise<WebSearchToolResult>;
}

export class WebSearchToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WebSearchToolError";
  }
}

function cleanText(value: string, maximumLength: number): string {
  const withoutControls = [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || code > 31;
    })
    .join("");
  return withoutControls
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximumLength);
}

function safeResultUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const normalized = url.toString();
    return ["http:", "https:"].includes(url.protocol) &&
      normalized.length <= 2_000
      ? normalized
      : null;
  } catch {
    return null;
  }
}

export interface SearxngWebSearchOptions {
  baseUrl: string;
  timeoutMs?: number;
  maxResults?: number;
  maxSnippetCharacters?: number;
  engines?: readonly string[];
}

export class SearxngWebSearchTool implements WebSearchTool {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxResults: number;
  private readonly maxSnippetCharacters: number;
  private readonly engines: readonly string[];

  constructor(
    options: SearxngWebSearchOptions,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxResults = options.maxResults ?? 5;
    this.maxSnippetCharacters = options.maxSnippetCharacters ?? 1_000;
    this.engines = options.engines ?? [];
  }

  async isReady(): Promise<boolean> {
    try {
      await this.search("OpenAI official website");
      return true;
    } catch {
      return false;
    }
  }

  async search(query: string): Promise<WebSearchToolResult> {
    const normalizedQuery = cleanText(query, 500);
    if (normalizedQuery.length === 0) {
      throw new WebSearchToolError(
        "AI_WEB_SEARCH_INVALID_QUERY",
        "The web search query is empty.",
      );
    }
    const startedAt = Date.now();
    const endpoint = new URL("search", `${this.baseUrl}/`);
    endpoint.searchParams.set("q", normalizedQuery);
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("safesearch", "1");
    if (this.engines.length > 0) {
      endpoint.searchParams.set("engines", this.engines.join(","));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(endpoint, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new WebSearchToolError(
          `AI_WEB_SEARCH_HTTP_${response.status}`,
          `The web search service returned HTTP ${response.status}.`,
        );
      }
      const parsed = searxngResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new WebSearchToolError(
          "AI_WEB_SEARCH_INVALID_RESPONSE",
          "The web search service returned an invalid response.",
        );
      }
      const results = parsed.data.results.flatMap((item) => {
        const url = safeResultUrl(item.url);
        if (url === null) return [];
        return [
          {
            title: cleanText(item.title ?? url, 300),
            url,
            snippet: cleanText(item.content ?? "", this.maxSnippetCharacters),
            publishedAt: item.publishedDate?.slice(0, 100) ?? null,
            source: item.engine?.slice(0, 100) ?? null,
          },
        ];
      });
      return {
        results: results.slice(0, this.maxResults),
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (error) {
      if (error instanceof WebSearchToolError) throw error;
      const timedOut =
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError");
      throw new WebSearchToolError(
        timedOut ? "AI_WEB_SEARCH_TIMEOUT" : "AI_WEB_SEARCH_CONNECTION_FAILED",
        timedOut
          ? "The web search service timed out."
          : "The web search service connection failed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
