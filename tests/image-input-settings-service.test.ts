import { describe, expect, it } from "vitest";

import { ImageInputSettingsService } from "../modules/ai/image-input-settings-service.js";
import type { ImageInputSettingsUpdate } from "../modules/ai/image-input-settings-types.js";
import { InMemoryImageInputSettingsRepository } from "./support/in-memory-image-input-settings-repository.js";

const defaults = {
  enabled: false,
  includeAttachments: true,
  includeLinkPreviewImages: true,
  maxCurrentAttachments: 4,
  maxHistoryImages: 2,
  maxTotalImages: 6,
  maxImageBytes: 10_485_760,
  maxTotalBytes: 20_971_520,
  fetchTimeoutMs: 15_000,
  detail: "high" as const,
};

describe("ImageInputSettingsService", () => {
  it("uses disabled application defaults before settings are saved", async () => {
    const service = new ImageInputSettingsService(
      new InMemoryImageInputSettingsRepository(
        () => new Date("2026-08-09T00:00:00.000Z"),
      ),
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

  it("persists global settings and rejects a stale update", async () => {
    const service = new ImageInputSettingsService(
      new InMemoryImageInputSettingsRepository(),
      defaults,
    );
    const input: ImageInputSettingsUpdate = {
      ...defaults,
      enabled: true,
      maxHistoryImages: 1,
      expectedVersion: 0,
    };

    await expect(service.update(input)).resolves.toMatchObject({
      status: "ok",
      value: {
        enabled: true,
        maxHistoryImages: 1,
        source: "database",
        version: 1,
      },
    });
    await expect(service.update(input)).resolves.toEqual({
      status: "conflict",
    });
    await expect(service.resolve()).resolves.toMatchObject({
      enabled: true,
      maxHistoryImages: 1,
    });
  });
});
