import { AuthService } from "../modules/auth/auth-service.js";
import { InMemoryAuthRepository } from "./support/in-memory-auth-repository.js";
import { describe, it, expect, vi } from "vitest";
import { buildApplication } from "../app/application.js";
import type { AppConfig } from "../app/config.js";
import { hashPassword } from "../app/security.js";
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
  it("requires sensitive authorization to rebuild an index and audits denial and success", async () => {
    const loginPassword = "fictional-login-password";
    const sensitivePassword = "fictional-sensitive-password";
    const loginPasswordHash = await hashPassword(
      loginPassword,
      Buffer.from("login-test-salt-1"),
    );
    const sensitiveOperationPasswordHash = await hashPassword(
      sensitivePassword,
      Buffer.from("stepup-test-salt"),
    );
    const authRepository = new InMemoryAuthRepository();
    const rebuild = vi.fn().mockResolvedValue({ memory: true });
    const app = buildApplication(
      { ...config, loginPasswordHash, sensitiveOperationPasswordHash },
      new InMemoryArchiveRepository(),
      {
        botIdentity: {
          rebuild,
          close: () => Promise.resolve(),
        } as unknown as BotIdentityService,
        auth: new AuthService(authRepository, {
          loginPasswordHash,
          sensitiveOperationPasswordHash,
          sessionTtlSeconds: 43200,
          sensitiveOperationTtlSeconds: 300,
        }),
        logger: false,
      },
    );
    try {
      const url =
        "/api/v1/chats/22222222-2222-4222-8222-222222222222/bot-identity/rebuild";
      expect((await app.inject({ method: "POST", url })).statusCode).toBe(401);
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/session",
        payload: { password: loginPassword },
      });
      const headers = {
        cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        origin: "http://localhost",
      };
      const denied = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { target: "memory" },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({
        error: { code: "SENSITIVE_AUTH_REQUIRED" },
      });
      expect(rebuild).not.toHaveBeenCalled();
      const verify = await app.inject({
        method: "POST",
        url: "/api/v1/auth/sensitive",
        headers,
        payload: { password: sensitivePassword },
      });
      expect(verify.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers,
            payload: { target: "memory" },
          })
        ).statusCode,
      ).toBe(200);
      expect(rebuild).toHaveBeenCalledExactlyOnceWith(
        "22222222-2222-4222-8222-222222222222",
        "memory",
      );
      const grant = [...authRepository.grants.values()][0];
      if (!grant) throw new Error("Sensitive grant fixture missing");
      authRepository.grants.set(grant.sessionId, {
        ...grant,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
      expect(
        (await app.inject({ method: "POST", url, headers })).statusCode,
      ).toBe(403);
      expect(rebuild).toHaveBeenCalledTimes(1);
      for (const outcome of ["denied", "succeeded"])
        expect(authRepository.auditEvents).toContainEqual(
          expect.objectContaining({ action: "bot-identity.rebuild", outcome }),
        );
    } finally {
      await app.close();
    }
  });

  it("requires admin, validates input, and preserves exact workflow target", async () => {
    const view = vi.fn().mockResolvedValue({
      workflowId: "11111111-1111-4111-8111-111111111111",
      nickname: null,
      version: 0,
    });
    const update = vi
      .fn()
      .mockResolvedValue({ nickname: "虚构甲", version: 1 });
    const rebuild = vi.fn().mockResolvedValue({ memory: true });
    const status = vi.fn().mockResolvedValue({});
    const startBackfill = vi.fn().mockResolvedValue({});
    const identity = {
      status,
      startBackfill,
      rebuild,
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
      const workflowId = "11111111-1111-4111-8111-111111111111";
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/v1/bot-attributions?workflowId=${workflowId}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(status).toHaveBeenCalledWith(workflowId);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/bot-attributions?workflowId=invalid",
            headers,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/bot-attributions/backfill",
            headers,
            payload: { workflowId },
          })
        ).statusCode,
      ).toBe(200);
      expect(startBackfill).toHaveBeenCalledWith(workflowId);
      const rebuildUrl =
        "/api/v1/chats/22222222-2222-4222-8222-222222222222/bot-identity/rebuild";
      expect(
        (
          await app.inject({
            method: "POST",
            url: rebuildUrl,
            payload: { target: "memory" },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: rebuildUrl,
            headers,
            payload: { target: "invalid" },
          })
        ).statusCode,
      ).toBe(400);
      expect(rebuild).not.toHaveBeenCalled();
      expect(
        (
          await app.inject({
            method: "POST",
            url: rebuildUrl,
            headers,
            payload: { target: "memory" },
          })
        ).statusCode,
      ).toBe(200);
      expect(rebuild).toHaveBeenLastCalledWith(
        "22222222-2222-4222-8222-222222222222",
        "memory",
      );
      expect(
        (await app.inject({ method: "POST", url: rebuildUrl, headers }))
          .statusCode,
      ).toBe(200);
      expect(rebuild).toHaveBeenLastCalledWith(
        "22222222-2222-4222-8222-222222222222",
        "memory",
      );
      expect(authRepository.auditEvents).toContainEqual(
        expect.objectContaining({
          action: "bot-identity.rebuild",
          outcome: "succeeded",
        }),
      );
    } finally {
      await app.close();
    }
  });
});
