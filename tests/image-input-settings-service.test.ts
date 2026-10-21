import { describe, expect, it } from "vitest";

import { ImageInputSettingsService } from "../modules/ai/image-input-settings-service.js";
import {
  imageInputSettingsUpdateSchema,
  type ImageInputSettingsUpdate,
} from "../modules/ai/image-input-settings-types.js";
import { InMemoryImageInputSettingsRepository } from "./support/in-memory-image-input-settings-repository.js";

const defaults = {
  enabled: false,
  includeAttachments: true,
  includeLinkPreviewImages: true,
  trustedLinkPreviewHosts: [],
  maxCurrentAttachments: 4,
  maxHistoryImages: 2,
  maxTotalImages: 6,
  maxImageBytes: 10_485_760,
  maxTotalBytes: 20_971_520,
  fetchTimeoutMs: 15_000,
  detail: "high" as const,
};

describe("ImageInputSettingsService", () => {
  it("normalizes exact trusted hosts and rejects wildcard or URL values", () => {
    expect(
      imageInputSettingsUpdateSchema.parse({
        ...defaults,
        trustedLinkPreviewHosts: [
          " Images.Example.Test ",
          "images.example.test",
        ],
        expectedVersion: 0,
      }).trustedLinkPreviewHosts,
    ).toEqual(["images.example.test"]);
    for (const host of [
      "*.example.test",
      "https://images.example.test",
      "images.example.test:443",
    ]) {
      expect(
        imageInputSettingsUpdateSchema.safeParse({
          ...defaults,
          trustedLinkPreviewHosts: [host],
          expectedVersion: 0,
        }).success,
      ).toBe(false);
    }
  });

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
  it("reads the shared policy without allowing legacy image writes to replace it", async () => {
    const repository = new InMemoryImageInputSettingsRepository();
    await repository.save({
      ...defaults,
      trustedLinkPreviewHosts: ["old.example.test"],
      expectedVersion: 0,
    });
    let hosts = ["shared.example.test"];
    const service = new ImageInputSettingsService(repository, defaults, () =>
      Promise.resolve(hosts),
    );
    expect((await service.resolve()).trustedLinkPreviewHosts).toEqual(hosts);
    await expect(
      service.update({ ...defaults, expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "NETWORK_SETTINGS_MOVED" });
    const { trustedLinkPreviewHosts: _, ...input } = defaults;
    void _;
    await expect(
      service.update({ ...input, expectedVersion: 1 }),
    ).resolves.toMatchObject({
      status: "ok",
      value: { trustedLinkPreviewHosts: hosts },
    });
    hosts = [];
    expect((await service.view()).trustedLinkPreviewHosts).toEqual([]);
    expect((await repository.find())?.trustedLinkPreviewHosts).toEqual([
      "old.example.test",
    ]);
  });
});
