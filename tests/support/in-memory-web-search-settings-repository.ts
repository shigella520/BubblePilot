import type {
  WebSearchSettingsRecord,
  WebSearchSettingsRepository,
  WebSearchSettingsSaveInput,
} from "../../modules/ai/web-search-settings-repository.js";

export class InMemoryWebSearchSettingsRepository implements WebSearchSettingsRepository {
  private stored: WebSearchSettingsRecord | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  find(): Promise<WebSearchSettingsRecord | null> {
    return Promise.resolve(this.stored === null ? null : { ...this.stored });
  }

  save(
    input: WebSearchSettingsSaveInput,
  ): Promise<
    { status: "ok"; value: WebSearchSettingsRecord } | { status: "conflict" }
  > {
    if (
      (this.stored === null && input.expectedVersion !== 0) ||
      (this.stored !== null && this.stored.version !== input.expectedVersion)
    ) {
      return Promise.resolve({ status: "conflict" });
    }
    const value: WebSearchSettingsRecord = {
      maxAttempts: input.maxAttempts,
      attemptTimeoutMs: input.attemptTimeoutMs,
      totalTimeoutMs: input.totalTimeoutMs,
      retryDelayMs: input.retryDelayMs,
      maxResults: input.maxResults,
      failurePolicy: input.failurePolicy,
      version: (this.stored?.version ?? 0) + 1,
      updatedAt: this.now().toISOString(),
    };
    this.stored = value;
    return Promise.resolve({ status: "ok", value: { ...value } });
  }

  isReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
