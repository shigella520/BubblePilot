import type { NetworkSettings } from "../modules/shared/network-settings.js";
import { it, expect, vi } from "vitest";
import { buildApplication } from "../app/application.js";
import type { AppConfig } from "../app/config.js";
import { hashPassword } from "../app/security.js";
import { AuthService } from "../modules/auth/auth-service.js";
import { InMemoryAuthRepository } from "./support/in-memory-auth-repository.js";
import { InMemoryArchiveRepository } from "./support/in-memory-archive-repository.js";
import type { PluginService } from "../modules/plugins/plugin-service.js";
it("plugin management enforces admin, sensitive grant, and audit", async () => {
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

  const mutate = vi.fn().mockResolvedValue({ enabled: true });
  const stage = vi.fn().mockResolvedValue({
    id: "fictional-import",
    state: "failed",
    directories: [],
    error_code: "PLUGIN_NO_PLUGIN_MANIFEST",
  });
  const updateRuntimeSettings = vi
    .fn()
    .mockResolvedValue({ catalogueCharacters: 64000, version: 2 });
  const plugins = {
    updateRuntimeSettings,
    runtimeSettings: () =>
      Promise.resolve({ catalogueCharacters: 64000, version: 1 }),
    runtimeUsage: () =>
      Promise.resolve({
        characters: 4,
        toolCount: 0,
        plugins: [],
        sharedCharacters: 4,
      }),
    stage,
    list: () => Promise.resolve([]),
    mutate,
    close: () => Promise.resolve(),
  } as unknown as PluginService;
  const networkUpdate = vi
    .fn()
    .mockResolvedValue({ trustedFakeIpHosts: ["example.test"], version: 2 });
  const networkSettings = {
    view: () => Promise.resolve({ trustedFakeIpHosts: [], version: 1 }),
    update: networkUpdate,
    close: async () => {},
  } as unknown as NetworkSettings;
  const app = buildApplication(config, new InMemoryArchiveRepository(), {
    logger: false,
    webRoot: false,
    plugins,
    networkSettings,
    auth: new AuthService(authRepository, {
      loginPasswordHash,
      sensitiveOperationPasswordHash,
      sessionTtlSeconds: 43200,
      sensitiveOperationTtlSeconds: 300,
    }),
  });
  try {
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/plugins" })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/settings/network" }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/settings/plugins" }))
        .statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const headers = { cookie, origin: "http://localhost" };
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/plugins", headers }))
        .statusCode,
    ).toBe(200);
    const networkRequest = {
      method: "PUT" as const,
      url: "/api/v1/settings/network",
      headers,
      payload: { trustedFakeIpHosts: ["example.test"], expectedVersion: 1 },
    };
    expect(
      (await app.inject({ method: "GET", url: networkRequest.url, headers }))
        .statusCode,
    ).toBe(200);
    expect((await app.inject(networkRequest)).statusCode).toBe(403);
    expect(networkUpdate).not.toHaveBeenCalled();
    const settingsRequest = {
      method: "PUT" as const,
      url: "/api/v1/settings/plugins",
      headers,
      payload: { catalogueCharacters: 64000, expectedVersion: 1 },
    };
    expect(
      (await app.inject({ method: "GET", url: settingsRequest.url, headers }))
        .statusCode,
    ).toBe(200);
    expect((await app.inject(settingsRequest)).statusCode).toBe(403);
    expect(updateRuntimeSettings).not.toHaveBeenCalled();
    const request = {
      method: "PUT" as const,
      url: "/api/v1/plugins/11111111-1111-4111-8111-111111111111",
      headers,
      payload: { expectedVersion: 1, enabled: true },
    };
    expect((await app.inject(request)).statusCode).toBe(403);
    expect(mutate).not.toHaveBeenCalled();
    const importRequest = {
      method: "POST" as const,
      url: "/api/v1/plugins/imports",
      headers,
      payload: { url: "https://example.test/plugins.git", ref: "HEAD" },
    };
    expect((await app.inject(importRequest)).statusCode).toBe(403);
    expect(stage).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/sensitive",
          headers,
          payload: { password: "fictional-sensitive-password" },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(mutate).toHaveBeenCalledOnce();
    expect((await app.inject(settingsRequest)).statusCode).toBe(200);
    expect(updateRuntimeSettings).toHaveBeenCalledOnce();
    expect(
      authRepository.auditEvents.some(
        (e) => e.action === "plugin.settings.update",
      ),
    ).toBe(true);
    expect(
      (
        await app.inject({
          ...settingsRequest,
          payload: { catalogueCharacters: 0, expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject(networkRequest)).statusCode).toBe(200);
    expect(networkUpdate).toHaveBeenCalledOnce();
    expect(
      authRepository.auditEvents.some(
        (e) => e.action === "network.settings.update",
      ),
    ).toBe(true);
    networkUpdate.mockResolvedValueOnce(null);
    expect((await app.inject(networkRequest)).statusCode).toBe(409);
    expect(
      (
        await app.inject({
          ...networkRequest,
          payload: { trustedFakeIpHosts: ["*"], expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(400);
    const imported = await app.inject(importRequest);
    expect(imported.statusCode).toBe(200);
    expect(
      imported.json<{ data: { error_code: string } }>().data.error_code,
    ).toBe("PLUGIN_NO_PLUGIN_MANIFEST");
    expect(stage).toHaveBeenCalledOnce();
    expect(
      authRepository.auditEvents.some((e) => e.action === "plugin.update"),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
