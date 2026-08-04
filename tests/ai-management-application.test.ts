import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../app/application.js";
import type { AppConfig } from "../app/config.js";
import { AiManagementService } from "../modules/ai/ai-management-service.js";
import type { AiClient } from "../modules/ai/openai-compatible-client.js";
import type { AiCallResult, AiProviderRecord } from "../modules/ai/ai-types.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";
import { InMemoryArchiveRepository } from "./support/in-memory-archive-repository.js";

const apiAccessToken = "fictional-api-access-token-32-chars-long";
const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 8080,
  databaseUrl: "postgresql://unused.example.test/bubblepilot",
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

class SuccessfulAiClient implements AiClient {
  readonly calls: AiProviderRecord[] = [];

  call(provider: AiProviderRecord): Promise<AiCallResult> {
    this.calls.push(provider);
    return Promise.resolve({
      status: "succeeded",
      text: "OK",
      durationMs: 7,
    });
  }
}

describe("AI management API", () => {
  let repository: InMemoryAiRepository;
  let client: SuccessfulAiClient;
  let application: FastifyInstance;
  let now: number;

  beforeEach(() => {
    now = Date.parse("2026-08-03T00:00:00.000Z");
    repository = new InMemoryAiRepository(() => now);
    client = new SuccessfulAiClient();
    const secrets = new EnvironmentSecretResolver({
      PRIMARY_AI_KEY: "primary-server-secret",
      BACKUP_AI_KEY: "backup-server-secret",
    });
    application = buildApplication(config, new InMemoryArchiveRepository(), {
      logger: false,
      ai: {
        repository,
        management: new AiManagementService(repository, client, secrets),
      },
    });
  });

  afterEach(async () => {
    await application.close();
  });

  const request = (input: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    payload?: Record<string, unknown>;
  }) =>
    application.inject({
      ...input,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });

  async function createProvider(name: string, secretRef: string) {
    const response = await request({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: {
        name,
        apiKind: "chat-completions",
        baseUrl: "https://ai.example.test/v1/",
        model: "fictional-model",
        secretRef,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{
      data: {
        id: string;
        version: number;
        secretRef: string;
        secretConfigured: boolean;
        sortOrder: number;
      };
    }>().data;
  }

  it("manages, reorders, tests, and routes providers without exposing secrets", async () => {
    const primary = await createProvider("Primary", "PRIMARY_AI_KEY");
    const backup = await createProvider("Backup", "BACKUP_AI_KEY");
    expect(primary).toMatchObject({
      secretConfigured: true,
      sortOrder: 100,
    });
    expect(primary).not.toHaveProperty("secretRef");

    const reordered = await request({
      method: "PUT",
      url: "/api/v1/ai/providers/reorder",
      payload: {
        providers: [
          { id: backup.id, expectedVersion: backup.version },
          { id: primary.id, expectedVersion: primary.version },
        ],
      },
    });
    expect(reordered.statusCode).toBe(200);
    const ordered = reordered.json<{
      data: Array<{ id: string; version: number }>;
    }>().data;
    expect(ordered.map((provider) => provider.id)).toEqual([
      backup.id,
      primary.id,
    ]);
    const missingSecret = await createProvider("Missing", "MISSING_AI_KEY");
    const directSecret = await request({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: {
        name: "Direct Key",
        apiKind: "chat-completions",
        baseUrl: "https://ai.example.test/v1",
        model: "fictional-model",
        secret: "sk-direct-provider-secret",
      },
    });
    expect(directSecret.statusCode).toBe(201);
    expect(directSecret.body).not.toContain("sk-direct-provider-secret");

    await repository.recordProviderFailure({
      providerId: primary.id,
      errorCode: "FICTIONAL_FAILURE",
      countsForDegrade: true,
      failureThreshold: 3,
      cooldownMs: 1_000,
    });
    const healthBeforeTest = await repository.getProviderHealth(primary.id);
    const tested = await request({
      method: "POST",
      url: `/api/v1/ai/providers/${primary.id}/test`,
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      data: {
        success: true,
        providerId: primary.id,
        errorCode: null,
      },
    });
    expect(await repository.getProviderHealth(primary.id)).toEqual(
      healthBeforeTest,
    );
    expect(client.calls).toHaveLength(1);

    const route = await request({
      method: "POST",
      url: "/api/v1/ai/routes",
      payload: {
        name: "Default route",
        providerIds: [primary.id, missingSecret.id, backup.id],
        fallbackEnabled: true,
        retryPolicy: { maxRounds: 2, initialDelayMs: 0 },
        degradePolicy: { failureThreshold: 3, cooldownMs: 1_000 },
        enabled: true,
      },
    });
    expect(route.statusCode).toBe(201);
    const routeData = route.json<{
      data: {
        id: string;
        version: number;
        configuredProviderIds: string[];
        effectiveProviderIds: string[];
        unavailableProviderIds: string[];
      };
    }>().data;
    expect(routeData.configuredProviderIds).toEqual([
      primary.id,
      missingSecret.id,
      backup.id,
    ]);
    expect(routeData.effectiveProviderIds).toEqual([primary.id, backup.id]);
    expect(routeData.unavailableProviderIds).toEqual([missingSecret.id]);

    await repository.recordProviderFailure({
      providerId: primary.id,
      errorCode: "FICTIONAL_TIMEOUT",
      countsForDegrade: true,
      failureThreshold: 1,
      cooldownMs: 1_000,
    });
    const coolingRoute = await request({
      method: "GET",
      url: `/api/v1/ai/routes/${routeData.id}`,
    });
    expect(coolingRoute.json()).toMatchObject({
      data: {
        effectiveProviderIds: [backup.id],
        unavailableProviderIds: [primary.id, missingSecret.id],
      },
    });
    now += 1_001;
    const probeReadyRoute = await request({
      method: "GET",
      url: `/api/v1/ai/routes/${routeData.id}`,
    });
    expect(probeReadyRoute.json()).toMatchObject({
      data: {
        effectiveProviderIds: [primary.id, backup.id],
        unavailableProviderIds: [missingSecret.id],
      },
    });

    const staleDisable = await request({
      method: "PATCH",
      url: `/api/v1/ai/providers/${primary.id}/enabled`,
      payload: { enabled: false, expectedVersion: primary.version },
    });
    expect(staleDisable.statusCode).toBe(409);

    const currentPrimary = ordered.find(
      (provider) => provider.id === primary.id,
    );
    const referencedDisable = await request({
      method: "PATCH",
      url: `/api/v1/ai/providers/${primary.id}/enabled`,
      payload: {
        enabled: false,
        expectedVersion: currentPrimary?.version,
      },
    });
    expect(referencedDisable.statusCode).toBe(200);

    const providerList = await request({
      method: "GET",
      url: "/api/v1/ai/providers",
    });
    expect(providerList.body).not.toContain("primary-server-secret");
    expect(providerList.body).not.toContain("backup-server-secret");
  });

  it("requires API authentication and rejects non-HTTP provider URLs", async () => {
    const unauthorized = await application.inject({
      method: "GET",
      url: "/api/v1/ai/providers",
    });
    expect(unauthorized.statusCode).toBe(401);

    const invalid = await request({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: {
        name: "Invalid",
        apiKind: "chat-completions",
        baseUrl: "ftp://ai.example.test/v1",
        model: "fictional-model",
        secretRef: "PRIMARY_AI_KEY",
      },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
