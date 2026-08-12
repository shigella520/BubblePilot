import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../app/application.js";
import type { AppConfig } from "../app/config.js";
import { AiManagementService } from "../modules/ai/ai-management-service.js";
import { ImageInputSettingsService } from "../modules/ai/image-input-settings-service.js";
import type { AiClient } from "../modules/ai/openai-compatible-client.js";
import type {
  AiCallResult,
  AiChatRequest,
  AiProviderRecord,
} from "../modules/ai/ai-types.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import { WebSearchSettingsService } from "../modules/ai/web-search-settings-service.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";
import { InMemoryArchiveRepository } from "./support/in-memory-archive-repository.js";
import { InMemoryImageInputSettingsRepository } from "./support/in-memory-image-input-settings-repository.js";
import { InMemoryWebSearchSettingsRepository } from "./support/in-memory-web-search-settings-repository.js";

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

class SuccessfulAiClient implements AiClient {
  readonly calls: AiProviderRecord[] = [];
  readonly requests: AiChatRequest[] = [];

  call(
    provider: AiProviderRecord,
    request: AiChatRequest,
  ): Promise<AiCallResult> {
    this.calls.push(provider);
    this.requests.push(request);
    if (request.tools?.some((tool) => tool.name === "capability_probe")) {
      return Promise.resolve({
        status: "succeeded",
        text: "",
        toolCalls: [
          { id: "fictional-call", name: "capability_probe", arguments: "{}" },
        ],
        durationMs: 7,
      });
    }
    if (
      request.messages.some(
        (message) =>
          typeof message.content !== "string" &&
          message.content.some((part) => part.type === "image"),
      )
    ) {
      return Promise.resolve({
        status: "succeeded",
        text: "green red blue",
        durationMs: 7,
      });
    }
    return Promise.resolve({
      status: "succeeded",
      text: "OK",
      durationMs: 7,
    });
  }
}

class RetryingImageAiClient implements AiClient {
  imageAttempts = 0;

  call(
    _provider: AiProviderRecord,
    request: AiChatRequest,
  ): Promise<AiCallResult> {
    const hasImage = request.messages.some(
      (message) =>
        typeof message.content !== "string" &&
        message.content.some((part) => part.type === "image"),
    );
    if (!hasImage) {
      return Promise.resolve({
        status: "succeeded",
        text: "OK",
        durationMs: 3,
      });
    }
    this.imageAttempts += 1;
    if (this.imageAttempts === 1) {
      return Promise.resolve({
        status: "failed",
        category: "server-error",
        code: "AI_PROVIDER_HTTP_503",
        summary: "The AI provider returned HTTP 503.",
        retryable: true,
        fallbackAllowed: true,
        countsForDegrade: true,
        durationMs: 5,
        diagnostics: {
          clientRequestId: null,
          providerRequestId: "probe-request-1",
          httpStatus: 503,
          requestHash: "request-hash",
          requestMessageCount: 1,
          requestCharacters: 1,
          responseBytes: 1,
          responseBodyHash: "response-hash",
          responseFinishReason: null,
          responseContentCharacters: 0,
          responseReasoningCharacters: 0,
          promptTokens: null,
          completionTokens: null,
          reasoningTokens: null,
          totalTokens: null,
          cachedPromptTokens: null,
          cacheWritePromptTokens: null,
          cacheMissPromptTokens: null,
        },
      });
    }
    return Promise.resolve({
      status: "succeeded",
      text: "绿色、蓝色、红色",
      durationMs: 7,
    });
  }
}

class MismatchingImageAiClient implements AiClient {
  call(
    _provider: AiProviderRecord,
    request: AiChatRequest,
  ): Promise<AiCallResult> {
    const hasImage = request.messages.some(
      (message) =>
        typeof message.content !== "string" &&
        message.content.some((part) => part.type === "image"),
    );
    return Promise.resolve({
      status: "succeeded",
      text: hasImage
        ? `I cannot inspect this image.\n${"x".repeat(200)}`
        : "OK",
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
        searchSettings: new WebSearchSettingsService(
          new InMemoryWebSearchSettingsRepository(
            () => new Date("2026-08-07T00:00:00.000Z"),
          ),
          {
            maxAttempts: 2,
            attemptTimeoutMs: 8_000,
            retryDelayMs: 300,
            maxResults: 5,
            failurePolicy: "mode-default",
          },
        ),
        imageInputSettings: new ImageInputSettingsService(
          new InMemoryImageInputSettingsRepository(
            () => new Date("2026-08-09T00:00:00.000Z"),
          ),
          {
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
            detail: "high",
          },
        ),
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

  it("returns long-period and realtime AI usage with strict query validation", async () => {
    const providerId = "11111111-1111-4111-8111-111111111111";
    const metrics = {
      requestCount: 2,
      succeededRequestCount: 1,
      failedRequestCount: 1,
      promptTokens: 1_000,
      completionTokens: 100,
      reasoningTokens: 20,
      totalTokens: 1_100,
      cachedPromptTokens: 800,
      cacheEligiblePromptTokens: 1_000,
      cacheHitRate: 0.8,
      cacheDataCoverage: 1,
    };
    repository.usageReport = {
      generatedAt: "2026-08-11T01:00:00.000Z",
      timeZone: "Asia/Shanghai",
      hours: 6,
      bucketMinutes: 5,
      providers: [{ id: providerId, name: "Fictional Provider" }],
      periods: [
        {
          providerId,
          providerName: "Fictional Provider",
          today: metrics,
          week: metrics,
          month: metrics,
        },
      ],
      series: [
        {
          bucketStart: "2026-08-11T00:55:00.000Z",
          providers: [{ providerId, ...metrics }],
        },
      ],
    };

    const response = await request({
      method: "GET",
      url: "/api/v1/ai/usage?hours=6&timeZone=Asia%2FShanghai",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        hours: 6,
        bucketMinutes: 5,
        periods: [{ providerId, today: { totalTokens: 1_100 } }],
        series: [{ providers: [{ cacheHitRate: 0.8 }] }],
      },
    });

    await expect(
      request({ method: "GET", url: "/api/v1/ai/usage?hours=5" }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      request({
        method: "GET",
        url: "/api/v1/ai/usage?timeZone=Fictional%2FInvalid",
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
  });

  it("independently probes and persists configured provider capabilities", async () => {
    const created = await request({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: {
        name: "Primary",
        apiKind: "responses",
        baseUrl: "https://ai.example.test/v1",
        model: "fictional-model",
        secretRef: "PRIMARY_AI_KEY",
        capabilities: {
          functionCalling: true,
          hostedWebSearch: true,
          imageInput: true,
        },
      },
    });
    const providerId = created.json<{ data: { id: string } }>().data.id;
    const tested = await request({
      method: "POST",
      url: `/api/v1/ai/providers/${providerId}/test`,
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      data: {
        checks: [
          { name: "connectivity", status: "verified", attempts: 1 },
          { name: "functionCalling", status: "verified", attempts: 1 },
          { name: "hostedWebSearch", status: "verified", attempts: 1 },
          {
            name: "imageInput",
            status: "verified",
            attempts: 1,
            errorCode: null,
          },
        ],
      },
    });
    expect(client.requests).toHaveLength(4);
    expect(client.requests[1]).toMatchObject({ toolChoice: "required" });
    expect(client.requests[2]).toMatchObject({ webSearch: "required" });
    const imageContent = client.requests[3]?.messages[0]?.content;
    expect(Array.isArray(imageContent)).toBe(true);
    const imagePart =
      typeof imageContent === "string"
        ? undefined
        : imageContent?.find((part) => part.type === "image");
    const textPart =
      typeof imageContent === "string"
        ? undefined
        : imageContent?.find((part) => part.type === "text");
    expect(imagePart?.dataUrl).toMatch(/^data:image\/png;base64,/u);
    expect(textPart?.text).toContain("Image capability test v3");
    expect(client.requests[3]).toMatchObject({ maxOutputTokens: 128 });
    await expect(repository.getProvider(providerId)).resolves.toMatchObject({
      capabilityProbe: {
        functionCalling: "verified",
        hostedWebSearch: "verified",
        imageInput: "verified",
      },
    });
  });

  it("retries transient image probe failures and returns per-check diagnostics", async () => {
    const retryRepository = new InMemoryAiRepository(() => now);
    const retryClient = new RetryingImageAiClient();
    const created = await retryRepository.createProvider({
      name: "Retrying image provider",
      apiKind: "responses",
      baseUrl: "https://ai.example.test/v1",
      model: "fictional-vision-model",
      secretRef: "PRIMARY_AI_KEY",
      parameters: {},
      requestTimeoutMs: 30_000,
      enabled: true,
      capabilities: {
        functionCalling: false,
        hostedWebSearch: false,
        imageInput: true,
      },
    });
    expect(created.status).toBe("ok");
    if (created.status !== "ok") return;
    const service = new AiManagementService(
      retryRepository,
      retryClient,
      new EnvironmentSecretResolver({
        PRIMARY_AI_KEY: "primary-server-secret",
      }),
    );

    await expect(service.testProvider(created.value.id)).resolves.toMatchObject(
      {
        success: true,
        durationMs: 15,
        checks: [
          { name: "connectivity", status: "verified", attempts: 1 },
          {
            name: "imageInput",
            status: "verified",
            attempts: 2,
            durationMs: 12,
            errorCode: null,
          },
        ],
      },
    );
    expect(retryClient.imageAttempts).toBe(2);
  });

  it("uses the global image detail for the provider capability probe", async () => {
    const detailRepository = new InMemoryAiRepository(() => now);
    const detailClient = new SuccessfulAiClient();
    const created = await detailRepository.createProvider({
      name: "Configured detail provider",
      apiKind: "responses",
      baseUrl: "https://ai.example.test/v1",
      model: "fictional-vision-model",
      secretRef: "PRIMARY_AI_KEY",
      parameters: {},
      requestTimeoutMs: 30_000,
      enabled: true,
      capabilities: {
        functionCalling: false,
        hostedWebSearch: false,
        imageInput: true,
      },
    });
    expect(created.status).toBe("ok");
    if (created.status !== "ok") return;
    const imageSettings = new ImageInputSettingsService(
      new InMemoryImageInputSettingsRepository(),
      {
        enabled: true,
        includeAttachments: true,
        includeLinkPreviewImages: true,
        trustedLinkPreviewHosts: [],
        maxCurrentAttachments: 4,
        maxHistoryImages: 2,
        maxTotalImages: 6,
        maxImageBytes: 10_485_760,
        maxTotalBytes: 20_971_520,
        fetchTimeoutMs: 15_000,
        detail: "high",
      },
    );
    const service = new AiManagementService(
      detailRepository,
      detailClient,
      new EnvironmentSecretResolver({
        PRIMARY_AI_KEY: "primary-server-secret",
      }),
      false,
      undefined,
      undefined,
      imageSettings,
    );

    await service.testProvider(created.value.id);
    const content = detailClient.requests[1]?.messages[0]?.content;
    const image =
      typeof content === "string"
        ? undefined
        : content?.find((part) => part.type === "image");
    expect(image).toMatchObject({ type: "image", detail: "high" });
  });

  it("rejects an invalid built-in image before calling the provider", async () => {
    const probeRepository = new InMemoryAiRepository(() => now);
    const probeClient = new SuccessfulAiClient();
    const created = await probeRepository.createProvider({
      name: "Invalid image probe provider",
      apiKind: "responses",
      baseUrl: "https://ai.example.test/v1",
      model: "fictional-vision-model",
      secretRef: "PRIMARY_AI_KEY",
      parameters: {},
      requestTimeoutMs: 30_000,
      enabled: true,
      capabilities: {
        functionCalling: false,
        hostedWebSearch: false,
        imageInput: true,
      },
    });
    expect(created.status).toBe("ok");
    if (created.status !== "ok") return;
    const service = new AiManagementService(
      probeRepository,
      probeClient,
      new EnvironmentSecretResolver({
        PRIMARY_AI_KEY: "primary-server-secret",
      }),
      false,
      undefined,
      "data:image/png;base64,AAAA",
    );

    await expect(service.testProvider(created.value.id)).resolves.toMatchObject(
      {
        success: true,
        checks: [
          { name: "connectivity", status: "verified" },
          {
            name: "imageInput",
            status: "failed",
            attempts: 0,
            durationMs: 0,
            errorCode: "AI_IMAGE_PROBE_ASSET_INVALID",
          },
        ],
      },
    );
    expect(probeClient.requests).toHaveLength(1);
  });

  it("returns a bounded preview for a mismatching fixed image probe", async () => {
    const mismatchRepository = new InMemoryAiRepository(() => now);
    const created = await mismatchRepository.createProvider({
      name: "Mismatching image provider",
      apiKind: "responses",
      baseUrl: "https://ai.example.test/v1",
      model: "fictional-vision-model",
      secretRef: "PRIMARY_AI_KEY",
      parameters: {},
      requestTimeoutMs: 30_000,
      enabled: true,
      capabilities: {
        functionCalling: false,
        hostedWebSearch: false,
        imageInput: true,
      },
    });
    expect(created.status).toBe("ok");
    if (created.status !== "ok") return;
    const service = new AiManagementService(
      mismatchRepository,
      new MismatchingImageAiClient(),
      new EnvironmentSecretResolver({
        PRIMARY_AI_KEY: "primary-server-secret",
      }),
    );

    const result = await service.testProvider(created.value.id);
    expect(result).toMatchObject({
      success: true,
      checks: [
        { name: "connectivity", responsePreview: null },
        {
          name: "imageInput",
          status: "failed",
          errorCode: "AI_IMAGE_PROBE_MISMATCH",
        },
      ],
    });
    const imageCheck = result?.checks.find(
      (check) => check.name === "imageInput",
    );
    expect(imageCheck?.responsePreview).toHaveLength(160);
    expect(imageCheck?.responsePreview).toMatch(
      /^I cannot inspect this image\. x+/u,
    );
  });

  it("manages global native image settings with optimistic concurrency", async () => {
    const initial = await request({
      method: "GET",
      url: "/api/v1/ai/image-input/settings",
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      data: { enabled: false, source: "defaults", version: 0 },
    });

    const payload = {
      enabled: true,
      includeAttachments: true,
      includeLinkPreviewImages: true,
      trustedLinkPreviewHosts: ["images.example.test"],
      maxCurrentAttachments: 3,
      maxHistoryImages: 2,
      maxTotalImages: 5,
      maxImageBytes: 5_242_880,
      maxTotalBytes: 15_728_640,
      fetchTimeoutMs: 12_000,
      detail: "auto",
      expectedVersion: 0,
    };
    const updated = await request({
      method: "PUT",
      url: "/api/v1/ai/image-input/settings",
      payload,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      data: {
        enabled: true,
        detail: "auto",
        trustedLinkPreviewHosts: ["images.example.test"],
        source: "database",
        version: 1,
      },
    });

    const stale = await request({
      method: "PUT",
      url: "/api/v1/ai/image-input/settings",
      payload,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: "AI_IMAGE_INPUT_SETTINGS_CONFLICT" },
    });
  });

  it("manages global web search settings with optimistic concurrency", async () => {
    const initial = await request({
      method: "GET",
      url: "/api/v1/ai/search/settings",
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      data: {
        maxAttempts: 2,
        attemptTimeoutMs: 8_000,
        retryDelayMs: 300,
        maxResults: 5,
        failurePolicy: "mode-default",
        source: "defaults",
        version: 0,
        updatedAt: null,
      },
    });
    expect(
      initial.json<{ data: Record<string, unknown> }>().data,
    ).not.toHaveProperty("totalTimeoutMs");

    const payload = {
      maxAttempts: 3,
      attemptTimeoutMs: 10_000,
      retryDelayMs: 500,
      maxResults: 8,
      failurePolicy: "continue",
      expectedVersion: 0,
    };
    const updated = await request({
      method: "PUT",
      url: "/api/v1/ai/search/settings",
      payload,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      data: {
        maxAttempts: 3,
        maxResults: 8,
        failurePolicy: "continue",
        source: "database",
        version: 1,
      },
    });

    const stale = await request({
      method: "PUT",
      url: "/api/v1/ai/search/settings",
      payload,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: "AI_WEB_SEARCH_SETTINGS_CONFLICT" },
    });

    const invalid = await request({
      method: "PUT",
      url: "/api/v1/ai/search/settings",
      payload: {
        ...payload,
        attemptTimeoutMs: 500,
        expectedVersion: 1,
      },
    });
    expect(invalid.statusCode).toBe(400);
  });

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
    expect(client.requests[0]).toMatchObject({
      maxOutputTokens: 128,
      temperature: 0,
    });

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
