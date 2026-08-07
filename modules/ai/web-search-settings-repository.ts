import type { WebSearchFailurePolicy } from "./ai-types.js";

export interface WebSearchSettingsRecord {
  maxAttempts: number;
  attemptTimeoutMs: number;
  totalTimeoutMs: number;
  retryDelayMs: number;
  maxResults: number;
  failurePolicy: WebSearchFailurePolicy;
  version: number;
  updatedAt: string;
}

export interface WebSearchSettingsSaveInput {
  maxAttempts: number;
  attemptTimeoutMs: number;
  totalTimeoutMs: number;
  retryDelayMs: number;
  maxResults: number;
  failurePolicy: WebSearchFailurePolicy;
  expectedVersion: number;
}

export interface WebSearchSettingsRepository {
  find(): Promise<WebSearchSettingsRecord | null>;
  save(
    input: WebSearchSettingsSaveInput,
  ): Promise<
    { status: "ok"; value: WebSearchSettingsRecord } | { status: "conflict" }
  >;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
