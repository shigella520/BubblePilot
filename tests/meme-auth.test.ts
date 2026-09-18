/* eslint-disable @typescript-eslint/unbound-method -- These methods are Vitest spies, never invoked unbound. */
import { it, expect, vi } from "vitest";
import { buildApplication } from "../app/application.js";
import type { AppConfig } from "../app/config.js";
import { hashPassword } from "../app/security.js";
import { AuthService } from "../modules/auth/auth-service.js";
import { InMemoryAuthRepository } from "./support/in-memory-auth-repository.js";
import { InMemoryArchiveRepository } from "./support/in-memory-archive-repository.js";
import type { MemeService } from "../modules/memes/meme-service.js";
import type { MemeDeliveryService } from "../modules/memes/meme-delivery-service.js";
it("meme management needs login but no sensitive grant; production retry still needs it", async () => {
  const loginPassword = "fictional-login-password";
  const loginPasswordHash = await hashPassword(loginPassword);
  const sensitiveOperationPasswordHash = await hashPassword(
    "fictional-sensitive-password",
  );
  const config: AppConfig = {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 8080,
    databaseUrl: "postgresql://unused.example.test/bubblepilot",
    databaseQueryTimeoutMs: 30_000,
    apiAccessToken: "fictional-api-access-token-32-chars-long",
    settingsEncryptionKey: "fictional-settings-encryption-key-32-chars",
    loginPasswordHash,
    sensitiveOperationPasswordHash,
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
  const authRepository = new InMemoryAuthRepository();
  const asset = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "虚构",
    version: 1,
    storageKey: "hidden-storage-key",
  };
  const memes = {
    start: vi.fn(),
    stop: vi.fn(),
    repository: {
      get: vi.fn().mockResolvedValue(asset),
      edit: vi.fn().mockResolvedValue({ ...asset, version: 2 }),
      remove: vi.fn().mockResolvedValue(true),
      close: vi.fn(),
    },
    files: { read: vi.fn().mockResolvedValue(Buffer.from("fictional")) },
  } as unknown as MemeService;
  const delivery = {
    start: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn().mockResolvedValue(null),
  } as unknown as MemeDeliveryService;
  const app = buildApplication(config, new InMemoryArchiveRepository(), {
    logger: false,
    webRoot: false,
    memes,
    memeDelivery: delivery,
    auth: new AuthService(authRepository, {
      loginPasswordHash,
      sensitiveOperationPasswordHash,
      sessionTtlSeconds: 43200,
      sensitiveOperationTtlSeconds: 300,
    }),
  });
  try {
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/memes/${asset.id}/file`,
        })
      ).statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const headers = { cookie, origin: "http://localhost" };
    const edit = await app.inject({
      method: "PUT",
      url: `/api/v1/memes/${asset.id}`,
      headers,
      payload: { name: "虚构", description: "", tags: [], expectedVersion: 1 },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.body).not.toContain("hidden-storage-key");
    expect(
      authRepository.auditEvents.some((e) => e.action === "meme.update"),
    ).toBe(true);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/meme-deliveries/${asset.id}/retry`,
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(delivery.retry).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v1/memes/${asset.id}`,
          headers,
          payload: { expectedVersion: 2 },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
  }
});
