import { describe, expect, it } from "vitest";

import { SettingsCipher } from "../modules/integrations/bluebubbles/settings-cipher.js";
import type {
  BlueBubblesSettingsRecord,
  BlueBubblesSettingsRepository,
} from "../modules/integrations/bluebubbles/settings-repository.js";
import { BlueBubblesSettingsService } from "../modules/integrations/bluebubbles/settings-service.js";

class InMemoryBlueBubblesSettingsRepository implements BlueBubblesSettingsRepository {
  record: BlueBubblesSettingsRecord | null = null;

  find() {
    return Promise.resolve(this.record);
  }

  save(input: Parameters<BlueBubblesSettingsRepository["save"]>[0]) {
    if (
      (this.record === null && input.expectedVersion !== 0) ||
      (this.record !== null && this.record.version !== input.expectedVersion)
    ) {
      return Promise.resolve({ status: "conflict" as const });
    }
    this.record = {
      serverUrl: input.serverUrl,
      encryptedAccessToken: input.encryptedAccessToken,
      encryptedWebhookSecret: input.encryptedWebhookSecret,
      sendMethod: input.sendMethod,
      requestTimeoutMs: input.requestTimeoutMs,
      version: input.expectedVersion + 1,
      updatedAt: new Date().toISOString(),
    };
    return Promise.resolve({ status: "ok" as const, value: this.record });
  }

  isReady() {
    return Promise.resolve(true);
  }

  close() {
    return Promise.resolve();
  }
}

describe("BlueBubblesSettingsService", () => {
  it("masks encrypted secrets, preserves omitted values, and resolves updates", async () => {
    const repository = new InMemoryBlueBubblesSettingsRepository();
    const service = new BlueBubblesSettingsService(
      repository,
      new SettingsCipher("fictional-settings-key-32-characters"),
      {
        serverUrl: "https://bluebubbles.example.test",
        accessToken: "environment-token",
        webhookSecret: "e".repeat(32),
        sendMethod: "private-api",
        requestTimeoutMs: 30_000,
      },
    );

    await expect(service.view()).resolves.toMatchObject({
      source: "environment",
      accessTokenConfigured: true,
      webhookSecretConfigured: true,
      version: 0,
    });
    await expect(
      service.update({
        serverUrl: "https://bluebubbles.internal.test",
        sendMethod: "apple-script",
        requestTimeoutMs: 45_000,
        expectedVersion: 0,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      value: {
        source: "database",
        version: 1,
        sendMethod: "apple-script",
      },
    });
    expect(repository.record?.encryptedAccessToken).not.toContain(
      "environment-token",
    );
    await expect(service.resolve()).resolves.toMatchObject({
      serverUrl: "https://bluebubbles.internal.test",
      accessToken: "environment-token",
      webhookSecret: "e".repeat(32),
      sendMethod: "apple-script",
      requestTimeoutMs: 45_000,
    });
  });

  it("rejects stale optimistic updates and verifies the active webhook secret", async () => {
    const repository = new InMemoryBlueBubblesSettingsRepository();
    const service = new BlueBubblesSettingsService(
      repository,
      new SettingsCipher("fictional-settings-key-32-characters"),
      {
        serverUrl: "https://bluebubbles.example.test",
        accessToken: "environment-token",
        webhookSecret: "e".repeat(32),
        sendMethod: "private-api",
        requestTimeoutMs: 30_000,
      },
    );
    await service.update({
      serverUrl: "https://one.example.test",
      sendMethod: "private-api",
      requestTimeoutMs: 30_000,
      expectedVersion: 0,
    });
    await expect(
      service.update({
        serverUrl: "https://stale.example.test",
        sendMethod: "private-api",
        requestTimeoutMs: 30_000,
        expectedVersion: 0,
      }),
    ).resolves.toEqual({ status: "conflict" });
    await expect(service.verifyWebhookSecret("e".repeat(32))).resolves.toBe(
      true,
    );
    await expect(service.verifyWebhookSecret("wrong")).resolves.toBe(false);
  });

  it("tests REST connectivity without returning credentials", async () => {
    const repository = new InMemoryBlueBubblesSettingsRepository();
    const fetchImplementation: typeof fetch = (input, init) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      expect(requestUrl).toContain("/api/v1/server/info?password=");
      expect(init?.method).toBe("GET");
      return Promise.resolve(
        new Response(JSON.stringify({ data: { version: "1.0.0" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const service = new BlueBubblesSettingsService(
      repository,
      new SettingsCipher("fictional-settings-key-32-characters"),
      {
        serverUrl: "https://bluebubbles.example.test",
        accessToken: "environment-token",
        webhookSecret: "e".repeat(32),
        sendMethod: "private-api",
        requestTimeoutMs: 30_000,
      },
      fetchImplementation,
    );

    await expect(service.testConnection()).resolves.toMatchObject({
      status: "connected",
      code: null,
      message: "BlueBubbles REST API 连接成功。",
    });
  });
});
