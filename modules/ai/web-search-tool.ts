import { z } from "zod";

const searxngResponseSchema = z.object({
  results: z.array(
    z
      .object({
        title: z.string().nullish(),
        url: z.string().nullish(),
        content: z.string().nullish(),
        publishedDate: z.string().nullish(),
        engine: z.string().nullish(),
      })
      .passthrough(),
  ),
  unresponsive_engines: z
    .array(z.tuple([z.string(), z.string()]))
    .optional()
    .default([]),
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
  requestDetails?: Readonly<Record<string, unknown>>;
  responseDetails?: Readonly<Record<string, unknown>>;
}

export interface WebSearchTool {
  isReady(): Promise<boolean>;
  search(query: string): Promise<WebSearchToolResult>;
}

export class WebSearchToolError extends Error {
  readonly requestDetails: Readonly<Record<string, unknown>> | null;
  readonly responseDetails: Readonly<Record<string, unknown>> | null;

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions & {
      requestDetails?: Readonly<Record<string, unknown>>;
      responseDetails?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message, options);
    this.name = "WebSearchToolError";
    this.requestDetails = options?.requestDetails ?? null;
    this.responseDetails = options?.responseDetails ?? null;
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
  language?: string;
}

interface EngineFailure {
  engine: string;
  reason: string;
}

interface SearxngSearchAttempt {
  query: string;
  strategy: "exact" | "relaxed-site";
  httpStatus: number;
  rawResultCount: number;
  results: readonly WebSearchResult[];
  engineFailures: readonly EngineFailure[];
}

interface SiteConstraint {
  domain: string;
  relaxedQuery: string;
}

const siteOperatorPattern = /(?:^|\s)site:([a-z0-9.-]+\.[a-z]{2,})(?=\s|$)/iu;

function siteConstraintFromQuery(query: string): SiteConstraint | null {
  const match = siteOperatorPattern.exec(query);
  const requestedDomain = match?.[1];
  if (match === null || requestedDomain === undefined) return null;
  try {
    const domain = new URL(`https://${requestedDomain}`).hostname.toLowerCase();
    const withoutOperator = query
      .replace(match[0], " ")
      .replace(/\s+/gu, " ")
      .trim();
    return {
      domain,
      relaxedQuery: [withoutOperator, domain].filter(Boolean).join(" "),
    };
  } catch {
    return null;
  }
}

function belongsToDomain(result: WebSearchResult, domain: string): boolean {
  const hostname = new URL(result.url).hostname.toLowerCase();
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function uniqueEngineFailures(
  attempts: readonly SearxngSearchAttempt[],
): readonly EngineFailure[] {
  const seen = new Set<string>();
  return attempts.flatMap((attempt) =>
    attempt.engineFailures.filter((failure) => {
      const key = `${failure.engine}\u0000${failure.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

export class SearxngWebSearchTool implements WebSearchTool {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxResults: number;
  private readonly maxSnippetCharacters: number;
  private readonly engines: readonly string[];
  private readonly language: string;

  constructor(
    options: SearxngWebSearchOptions,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxResults = options.maxResults ?? 5;
    this.maxSnippetCharacters = options.maxSnippetCharacters ?? 1_000;
    this.engines = options.engines ?? [];
    this.language = options.language?.trim() || "zh-CN";
  }

  async isReady(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const endpoint = new URL("healthz", `${this.baseUrl}/`);
      const response = await this.fetchImplementation(endpoint, {
        headers: { accept: "text/plain" },
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
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
    const siteConstraint = siteConstraintFromQuery(normalizedQuery);
    const auditEndpoint = new URL("search", `${this.baseUrl}/`);
    const requestDetails = {
      endpoint: `${auditEndpoint.origin}${auditEndpoint.pathname}`,
      query: normalizedQuery,
      language: this.language,
      safeSearch: 1,
      engines: [...this.engines],
      queryStrategy:
        siteConstraint === null ? "exact" : "site-with-relaxed-fallback",
      ...(siteConstraint === null
        ? {}
        : {
            siteConstraint: siteConstraint.domain,
            relaxedQuery: siteConstraint.relaxedQuery,
          }),
    };
    const attempts: SearxngSearchAttempt[] = [
      await this.searchOnce(
        normalizedQuery,
        "exact",
        this.timeoutMs,
        requestDetails,
      ),
    ];
    const exactResults =
      siteConstraint === null
        ? (attempts[0]?.results ?? [])
        : (attempts[0]?.results ?? []).filter((result) =>
            belongsToDomain(result, siteConstraint.domain),
          );
    let usableResults = exactResults;
    let relaxedSearchError: Readonly<Record<string, unknown>> | null = null;
    if (siteConstraint !== null && usableResults.length === 0) {
      const remainingMs = Math.max(
        0,
        this.timeoutMs - (Date.now() - startedAt),
      );
      if (remainingMs > 0) {
        try {
          const relaxedAttempt = await this.searchOnce(
            siteConstraint.relaxedQuery,
            "relaxed-site",
            remainingMs,
            {
              ...requestDetails,
              query: siteConstraint.relaxedQuery,
            },
          );
          attempts.push(relaxedAttempt);
          usableResults = relaxedAttempt.results.filter((result) =>
            belongsToDomain(result, siteConstraint.domain),
          );
        } catch (error) {
          if (!(error instanceof WebSearchToolError)) throw error;
          relaxedSearchError = {
            code: error.code,
            requestDetails: error.requestDetails,
            responseDetails: error.responseDetails,
          };
        }
      } else {
        relaxedSearchError = { code: "AI_WEB_SEARCH_TIMEOUT" };
      }
    }
    const retainedResults = usableResults.slice(0, this.maxResults);
    const engineFailures = uniqueEngineFailures(attempts);
    const responseDetails = {
      outcome: retainedResults.length > 0 ? "results" : "no_results",
      httpStatus: attempts.at(-1)?.httpStatus ?? 200,
      rawResultCount: attempts.reduce(
        (total, attempt) => total + attempt.rawResultCount,
        0,
      ),
      retainedResultCount: retainedResults.length,
      results: retainedResults,
      engineFailures,
      attempts: attempts.map((attempt) => ({
        strategy: attempt.strategy,
        query: attempt.query,
        httpStatus: attempt.httpStatus,
        rawResultCount: attempt.rawResultCount,
        normalizedResultCount: attempt.results.length,
        matchingResultCount:
          siteConstraint === null
            ? attempt.results.length
            : attempt.results.filter((result) =>
                belongsToDomain(result, siteConstraint.domain),
              ).length,
        engineFailures: attempt.engineFailures,
      })),
      ...(relaxedSearchError === null ? {} : { relaxedSearchError }),
    };
    return {
      results: retainedResults,
      durationMs: Math.max(0, Date.now() - startedAt),
      requestDetails,
      responseDetails,
    };
  }

  private async searchOnce(
    query: string,
    strategy: SearxngSearchAttempt["strategy"],
    timeoutMs: number,
    requestDetails: Readonly<Record<string, unknown>>,
  ): Promise<SearxngSearchAttempt> {
    const endpoint = new URL("search", `${this.baseUrl}/`);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    endpoint.searchParams.set("safesearch", "1");
    endpoint.searchParams.set("language", this.language);
    if (this.engines.length > 0) {
      endpoint.searchParams.set("engines", this.engines.join(","));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImplementation(endpoint, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new WebSearchToolError(
          `AI_WEB_SEARCH_HTTP_${response.status}`,
          `The web search service returned HTTP ${response.status}.`,
          {
            requestDetails,
            responseDetails: { httpStatus: response.status },
          },
        );
      }
      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch (error) {
        throw new WebSearchToolError(
          "AI_WEB_SEARCH_INVALID_RESPONSE",
          "The web search service returned invalid JSON.",
          {
            cause: error,
            requestDetails,
            responseDetails: {
              httpStatus: response.status,
              jsonParseFailed: true,
            },
          },
        );
      }
      const parsed = searxngResponseSchema.safeParse(responseBody);
      if (!parsed.success) {
        throw new WebSearchToolError(
          "AI_WEB_SEARCH_INVALID_RESPONSE",
          "The web search service returned an invalid response.",
          {
            requestDetails,
            responseDetails: {
              httpStatus: response.status,
              schemaIssues: parsed.error.issues.slice(0, 10).map((issue) => ({
                path: issue.path.map(String).join("."),
                code: issue.code,
                message: cleanText(issue.message, 300),
              })),
            },
          },
        );
      }
      const results = parsed.data.results.flatMap((item) => {
        const url =
          typeof item.url === "string" ? safeResultUrl(item.url) : null;
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
        query,
        strategy,
        httpStatus: response.status,
        rawResultCount: parsed.data.results.length,
        results,
        engineFailures: parsed.data.unresponsive_engines.map(
          ([engine, reason]) => ({
            engine: cleanText(engine, 100),
            reason: cleanText(reason, 300),
          }),
        ),
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
        { cause: error, requestDetails },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
