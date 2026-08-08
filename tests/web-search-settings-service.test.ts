import { describe, expect, it } from "vitest";

import { WebSearchSettingsService } from "../modules/ai/web-search-settings-service.js";
import { InMemoryWebSearchSettingsRepository } from "./support/in-memory-web-search-settings-repository.js";

const defaults = {
  maxAttempts: 2,
  attemptTimeoutMs: 8_000,
  retryDelayMs: 300,
  maxResults: 5,
  failurePolicy: "mode-default" as const,
};

describe("WebSearchSettingsService", () => {
  it("uses application defaults until an administrator saves settings", async () => {
    const service = new WebSearchSettingsService(
      new InMemoryWebSearchSettingsRepository(),
      defaults,
    );

    await expect(service.view()).resolves.toEqual({
      ...defaults,
      source: "defaults",
      version: 0,
      updatedAt: null,
    });
    await expect(service.resolve()).resolves.toEqual(defaults);
  });

  it("persists settings and rejects stale updates", async () => {
    const repository = new InMemoryWebSearchSettingsRepository(
      () => new Date("2026-08-07T00:00:00.000Z"),
    );
    const service = new WebSearchSettingsService(repository, defaults);
    const input = {
      maxAttempts: 3,
      attemptTimeoutMs: 10_000,
      retryDelayMs: 500,
      maxResults: 8,
      failurePolicy: "continue" as const,
      expectedVersion: 0,
    };

    await expect(service.update(input)).resolves.toEqual({
      status: "ok",
      value: {
        maxAttempts: 3,
        attemptTimeoutMs: 10_000,
        retryDelayMs: 500,
        maxResults: 8,
        failurePolicy: "continue",
        source: "database",
        version: 1,
        updatedAt: "2026-08-07T00:00:00.000Z",
      },
    });
    await expect(service.update(input)).resolves.toEqual({
      status: "conflict",
    });
    await expect(service.resolve()).resolves.toEqual({
      maxAttempts: 3,
      attemptTimeoutMs: 10_000,
      retryDelayMs: 500,
      maxResults: 8,
      failurePolicy: "continue",
    });
  });
});
