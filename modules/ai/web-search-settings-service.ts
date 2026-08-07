import type { WebSearchSettingsRepository } from "./web-search-settings-repository.js";
import type {
  WebSearchRuntimeSettings,
  WebSearchSettingsUpdate,
  WebSearchSettingsView,
} from "./web-search-settings-types.js";

export class WebSearchSettingsService {
  constructor(
    readonly repository: WebSearchSettingsRepository,
    private readonly fallback: WebSearchRuntimeSettings,
  ) {}

  async view(): Promise<WebSearchSettingsView> {
    const stored = await this.repository.find();
    return stored === null
      ? {
          ...this.fallback,
          source: "defaults",
          version: 0,
          updatedAt: null,
        }
      : { ...stored, source: "database" };
  }

  async resolve(): Promise<WebSearchRuntimeSettings> {
    const stored = await this.repository.find();
    return stored === null
      ? this.fallback
      : {
          maxAttempts: stored.maxAttempts,
          attemptTimeoutMs: stored.attemptTimeoutMs,
          totalTimeoutMs: stored.totalTimeoutMs,
          retryDelayMs: stored.retryDelayMs,
          maxResults: stored.maxResults,
          failurePolicy: stored.failurePolicy,
        };
  }

  async update(
    input: WebSearchSettingsUpdate,
  ): Promise<
    { status: "ok"; value: WebSearchSettingsView } | { status: "conflict" }
  > {
    const result = await this.repository.save(input);
    return result.status === "conflict"
      ? result
      : { status: "ok", value: { ...result.value, source: "database" } };
  }
}
