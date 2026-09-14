import { AuthService } from "../modules/auth/auth-service.js";
import { InMemoryAuthRepository } from "./support/in-memory-auth-repository.js";
import { describe, it, expect, vi } from "vitest";
import { buildApplication } from "../app/application.js";
import type { AppConfig } from "../app/config.js";
import type { BotIdentityService } from "../modules/identity/bot-identity-service.js";
import { InMemoryArchiveRepository } from "./support/in-memory-archive-repository.js";
const apiAccessToken = "fictional-api-access-token-32-chars-long";
const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 8080,
  databaseUrl: "postgresql://unused.example.test/bubblepilot",
  databaseQueryTimeoutMs: 30_000,
  apiAccessToken,
  settingsEncryptionKey: "fictional-settings-encryption-key-32-chars",
  loginPasswordHash: "scrypt$16384$8$1$fictional-salt$fictional-key",
  sensitiveOperationPasswordHash:
    "scrypt$16384$8$1$fictional-salt$fictional-key",
  adminSessionTtlSeconds: 43_200,
  sensitiveOperationTtlSeconds: 300,
  sessionCookieSecure: "auto",
  blueBubblesWebhookSecret: "fictional-webhook-secret-32-chars-long",
  blueBubblesServerUrl: "https://bluebubbles.example.test",
  blueBubblesAccessToken: "fictional-bluebubbles-token",
  blueBubblesSendMethod: "private-api",
  blueBubblesRequestTimeoutMs: 30_000,
  monitoredChatIds: new Set(),
  messageRetentionDays: 90,
  webhookBodyLimitBytes: 1_048_576,
  rateLimitWindowSeconds: 60,
  adminRateLimitMax: 600,
  webhookRateLimitMax: 300,
  workflowMaxConcurrency: 4,
  workflowQueueCapacity: 64,
  workflowQueueWaitMs: 30_000,
  staleRetrySeconds: 300,
  logLevel: "silent",
};

describe("Bot identity administrator API", () => {
  it("requires admin, validates input, and preserves exact workflow target", async () => {
    const view = vi.fn().mockResolvedValue({
      workflowId: "11111111-1111-4111-8111-111111111111",
      nickname: null,
      version: 0,
    });
    const update = vi
      .fn()
      .mockResolvedValue({ nickname: "虚构甲", version: 1 });
    const identity = {
      view,
      update,
      close: () => Promise.resolve(),
    } as unknown as BotIdentityService;
    const authRepository = new InMemoryAuthRepository();
    const app = buildApplication(config, new InMemoryArchiveRepository(), {
      botIdentity: identity,
      auth: new AuthService(authRepository, {
        loginPasswordHash: config.loginPasswordHash,
        sensitiveOperationPasswordHash: config.sensitiveOperationPasswordHash,
        sessionTtlSeconds: 43200,
        sensitiveOperationTtlSeconds: 300,
      }),
    });
    const path =
      "/api/v1/workflows/11111111-1111-4111-8111-111111111111/bot-identity";
    try {
      expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(
        401,
      );
      expect(view).not.toHaveBeenCalled();
      const headers = { authorization: `Bearer ${apiAccessToken}` };
      expect(
        (await app.inject({ method: "GET", url: path, headers })).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: path,
            headers,
            payload: { nickname: "", expectedVersion: 0 },
          })
        ).statusCode,
      ).toBe(400);
      expect(update).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: "PUT",
            url: path,
            headers,
            payload: { nickname: "虚构甲", expectedVersion: 0 },
          })
        ).statusCode,
      ).toBe(200);
      expect(authRepository.auditEvents).toContainEqual(
        expect.objectContaining({
          action: "workflow.bot-identity.update",
          outcome: "succeeded",
        }),
      );
      expect(update).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        { nickname: "虚构甲", expectedVersion: 0 },
      );
    } finally {
      await app.close();
    }
  });
});
