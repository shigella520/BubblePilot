import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import type { AiClient } from "../modules/ai/openai-compatible-client.js";
import type {
  AiCallResult,
  AiChatRequest,
  AiProviderConfiguration,
  AiProviderRecord,
  AiRouteRequest,
} from "../modules/ai/ai-types.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";

const configuration: AiProviderConfiguration = {
  name: "Fictional AI",
  apiKind: "chat-completions",
  baseUrl: "https://ai.example.test/v1",
  model: "fictional-model",
  secretRef: "FICTIONAL_AI_KEY",
  parameters: {},
  requestTimeoutMs: 5_000,
  enabled: true,
};

const routeRequest = (routeId: string): AiRouteRequest => ({
  executionId: randomUUID(),
  nodeId: "ask-ai",
  routeId,
  messages: [{ role: "user", content: "Fictional prompt" }],
  maxOutputTokens: 128,
  temperature: null,
  maxOutputCharacters: 4_000,
  outputFormat: "text",
  protectedPrompt: null,
});

function timeoutFailure(): AiCallResult {
  return {
    status: "failed",
    category: "timeout",
    code: "AI_PROVIDER_TIMEOUT",
    summary: "The AI provider request timed out.",
    retryable: true,
    fallbackAllowed: true,
    countsForDegrade: true,
    durationMs: 10,
  };
}

function secretResolver(
  values: Readonly<Record<string, string>> = {},
): EnvironmentSecretResolver {
  return new EnvironmentSecretResolver({
    PRIMARY_KEY: "primary-secret",
    BACKUP_KEY: "backup-secret",
    ...values,
  });
}

class FakeAiClient implements AiClient {
  readonly calls: string[] = [];
  readonly providerSnapshots: AiProviderRecord[] = [];
  readonly requests: AiChatRequest[] = [];

  constructor(
    private readonly callProvider: (
      provider: AiProviderRecord,
      callNumber: number,
    ) => AiCallResult | Promise<AiCallResult>,
  ) {}

  async call(
    provider: AiProviderRecord,
    request: AiChatRequest,
  ): Promise<AiCallResult> {
    this.calls.push(provider.id);
    this.providerSnapshots.push(structuredClone(provider));
    this.requests.push(structuredClone(request));
    return this.callProvider(provider, this.calls.length);
  }
}

async function provider(
  repository: InMemoryAiRepository,
  name: string,
): Promise<AiProviderRecord> {
  const result = await repository.createProvider({
    ...configuration,
    name,
    secretRef: `${name.toLocaleUpperCase("en-US")}_KEY`,
  });
  if (result.status !== "ok") {
    throw new Error("Provider fixture failed.");
  }
  return result.value;
}

async function route(
  repository: InMemoryAiRepository,
  providerIds: readonly string[],
  options: {
    threshold?: number;
    cooldownMs?: number;
    rounds?: number;
    fallbackEnabled?: boolean;
  } = {},
) {
  const result = await repository.createRoute({
    name: "Fictional route",
    providerIds,
    fallbackEnabled: options.fallbackEnabled ?? true,
    retryPolicy: {
      maxRounds: options.rounds ?? 2,
      initialDelayMs: 0,
    },
    degradePolicy: {
      failureThreshold: options.threshold ?? 3,
      cooldownMs: options.cooldownMs ?? 1_000,
    },
    enabled: true,
  });
  if (result.status !== "ok") {
    throw new Error("Route fixture failed.");
  }
  return result.value;
}

describe("AiRoutingService", () => {
  it("keeps the affinity session stable while request trace ids remain unique", async () => {
    const repository = new InMemoryAiRepository();
    const primary = await provider(repository, "primary");
    Object.assign(repository.providers.get(primary.id)!, {
      sessionAffinity: "session-id-header",
    });
    const configuredRoute = await route(repository, [primary.id], {
      rounds: 2,
      threshold: 10,
    });
    const client = new FakeAiClient((_, callNumber) =>
      callNumber === 1
        ? timeoutFailure()
        : { status: "succeeded", text: "Stable answer", durationMs: 1 },
    );
    const service = new AiRoutingService(repository, client, secretResolver());
    const firstRequest = {
      ...routeRequest(configuredRoute.id),
      sessionAffinityKey: "hashed-fictional-chat-workflow-node",
    };

    await expect(service.execute(firstRequest)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(
      service.execute({ ...firstRequest, executionId: randomUUID() }),
    ).resolves.toMatchObject({ status: "succeeded" });

    expect(client.requests.map((request) => request.sessionId)).toHaveLength(3);
    expect(
      new Set(client.requests.map((request) => request.sessionId)).size,
    ).toBe(1);
    expect(client.requests[0]?.sessionId).toMatch(/^bp_[a-f0-9]{64}$/u);
    expect(
      new Set(client.requests.map((request) => request.clientRequestId)).size,
    ).toBe(3);
  });

  it("does not send an affinity session unless the provider enables it", async () => {
    const repository = new InMemoryAiRepository();
    const primary = await provider(repository, "primary");
    const configuredRoute = await route(repository, [primary.id]);
    const client = new FakeAiClient(() => ({
      status: "succeeded",
      text: "Answer",
      durationMs: 1,
    }));
    const service = new AiRoutingService(repository, client, secretResolver());

    await service.execute({
      ...routeRequest(configuredRoute.id),
      sessionAffinityKey: "hashed-fictional-chat-workflow-node",
    });

    expect(client.requests[0]?.sessionId).toBeUndefined();
  });

  it("routes native image input only to a provider with a verified capability", async () => {
    const repository = new InMemoryAiRepository();
    const textOnly = await provider(repository, "Primary");
    const vision = await provider(repository, "Backup");
    Object.assign(repository.providers.get(textOnly.id)!, {
      capabilities: {
        functionCalling: false,
        hostedWebSearch: false,
        imageInput: false,
      },
      capabilityProbe: {
        functionCalling: "unknown",
        hostedWebSearch: "unknown",
        imageInput: "failed",
        checkedAt: new Date().toISOString(),
      },
    });
    Object.assign(repository.providers.get(vision.id)!, {
      capabilities: {
        functionCalling: false,
        hostedWebSearch: false,
        imageInput: true,
      },
      capabilityProbe: {
        functionCalling: "unknown",
        hostedWebSearch: "unknown",
        imageInput: "verified",
        checkedAt: new Date().toISOString(),
      },
    });
    const configuredRoute = await route(repository, [textOnly.id, vision.id]);
    const client = new FakeAiClient(() => ({
      status: "succeeded",
      text: "Image understood",
      durationMs: 1,
    }));
    const service = new AiRoutingService(repository, client, secretResolver());

    await expect(
      service.execute({
        ...routeRequest(configuredRoute.id),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe the fictional image." },
              {
                type: "image",
                dataUrl: "data:image/png;base64,ZmFrZQ==",
                detail: "low",
                label: "Fictional image",
              },
            ],
          },
        ],
      }),
    ).resolves.toMatchObject({ status: "succeeded", providerId: vision.id });
    expect(client.calls).toEqual([vision.id]);
  });

  it("falls back to text with an explicit limitation when no vision provider is available", async () => {
    const repository = new InMemoryAiRepository();
    const textOnly = await provider(repository, "Primary");
    const configuredRoute = await route(repository, [textOnly.id]);
    const client = new FakeAiClient(() => ({
      status: "succeeded",
      text: "Text-only answer",
      durationMs: 1,
    }));
    const service = new AiRoutingService(repository, client, secretResolver());

    await expect(
      service.execute({
        ...routeRequest(configuredRoute.id),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What does this show?" },
              {
                type: "image",
                dataUrl: "data:image/png;base64,ZmFrZQ==",
                detail: "low",
                label: "Fictional image",
              },
            ],
          },
        ],
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      providerId: textOnly.id,
      attemptCount: 1,
    });
    expect(client.requests).toHaveLength(1);
    const limitation = client.requests[0]?.messages.find(
      (message) =>
        message.role === "system" && typeof message.content === "string",
    );
    expect(limitation?.content).toContain(
      "could not provide the referenced images",
    );
    expect(
      client.requests[0]?.messages.some(
        (message) =>
          typeof message.content !== "string" &&
          message.content.some((part) => part.type === "image"),
      ),
    ).toBe(false);
  });

  it("does not strip images when a background image summary forbids degradation", async () => {
    const repository = new InMemoryAiRepository();
    const vision = await provider(repository, "Primary");
    Object.assign(repository.providers.get(vision.id)!, {
      capabilities: {
        functionCalling: false,
        hostedWebSearch: false,
        imageInput: true,
      },
      capabilityProbe: {
        functionCalling: "unknown",
        hostedWebSearch: "unknown",
        imageInput: "verified",
        checkedAt: new Date().toISOString(),
      },
    });
    const configuredRoute = await route(repository, [vision.id], { rounds: 1 });
    const client = new FakeAiClient(timeoutFailure);
    const service = new AiRoutingService(repository, client, secretResolver());

    await expect(
      service.execute({
        ...routeRequest(configuredRoute.id),
        allowImageDegrade: false,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Summarize." },
              {
                type: "image",
                dataUrl: "data:image/png;base64,ZmFrZQ==",
                detail: "high",
                label: "Fictional image",
              },
            ],
          },
        ],
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(client.requests).toHaveLength(1);
    expect(
      client.requests[0]?.messages.some(
        (message) =>
          typeof message.content !== "string" &&
          message.content.some((part) => part.type === "image"),
      ),
    ).toBe(true);
  });

  it("filters search routes to providers with verified hosted search", async () => {
    const repository = new InMemoryAiRepository();
    const primary = await provider(repository, "Primary");
    const backup = await provider(repository, "Backup");
    Object.assign(repository.providers.get(primary.id)!, {
      apiKind: "responses",
      capabilities: { functionCalling: true, hostedWebSearch: true },
      capabilityProbe: {
        functionCalling: "failed",
        hostedWebSearch: "failed",
        checkedAt: new Date().toISOString(),
      },
    });
    Object.assign(repository.providers.get(backup.id)!, {
      apiKind: "responses",
      capabilities: { functionCalling: true, hostedWebSearch: true },
      capabilityProbe: {
        functionCalling: "verified",
        hostedWebSearch: "verified",
        checkedAt: new Date().toISOString(),
      },
    });
    const configuredRoute = await route(repository, [primary.id, backup.id]);
    const client = new FakeAiClient(() => ({
      status: "succeeded",
      text: "Fresh answer",
      durationMs: 1,
    }));
    const service = new AiRoutingService(repository, client, secretResolver());

    await expect(
      service.execute({
        ...routeRequest(configuredRoute.id),
        webSearch: "auto",
      }),
    ).resolves.toMatchObject({ status: "succeeded", providerId: backup.id });
    expect(client.calls).toEqual([backup.id]);
  });

  it("falls back in fixed order and records every attempt", async () => {
    const repository = new InMemoryAiRepository();
    const primary = await provider(repository, "primary");
    const backup = await provider(repository, "backup");
    const configuredRoute = await route(repository, [primary.id, backup.id]);
    const client = new FakeAiClient((candidate) =>
      candidate.id === primary.id
        ? timeoutFailure()
        : { status: "succeeded", text: "Backup answer", durationMs: 8 },
    );
    const service = new AiRoutingService(repository, client, secretResolver());

    const result = await service.execute(routeRequest(configuredRoute.id));
    expect(result).toMatchObject({
      status: "succeeded",
      providerId: backup.id,
      round: 1,
      attemptCount: 2,
    });
    expect(client.calls).toEqual([primary.id, backup.id]);
    expect(repository.attempts).toMatchObject([
      { providerId: primary.id, round: 1, sequence: 1, status: "failed" },
      { providerId: backup.id, round: 1, sequence: 2, status: "succeeded" },
    ]);
  });

  it("attempts each provider once per retry round", async () => {
    const repository = new InMemoryAiRepository();
    const primary = await provider(repository, "primary");
    const backup = await provider(repository, "backup");
    const configuredRoute = await route(repository, [primary.id, backup.id], {
      rounds: 2,
      threshold: 10,
    });
    const client = new FakeAiClient(timeoutFailure);
    const service = new AiRoutingService(repository, client, secretResolver());

    await expect(
      service.execute(routeRequest(configuredRoute.id)),
    ).resolves.toMatchObject({
      status: "failed",
      code: "AI_PROVIDER_TIMEOUT",
      attemptCount: 4,
    });
    expect(client.calls).toEqual([
      primary.id,
      backup.id,
      primary.id,
      backup.id,
    ]);
    expect(
      repository.attempts.map(({ round, sequence }) => ({ round, sequence })),
    ).toEqual([
      { round: 1, sequence: 1 },
      { round: 1, sequence: 2 },
      { round: 2, sequence: 1 },
      { round: 2, sequence: 2 },
    ]);
  });

  it("retries a transient empty response from the same provider", async () => {
    const repository = new InMemoryAiRepository();
    const primary = await provider(repository, "primary");
    const configuredRoute = await route(repository, [primary.id], {
      rounds: 2,
      threshold: 10,
    });
    const client = new FakeAiClient((_, callNumber) =>
      callNumber === 1
        ? {
            status: "failed",
            category: "empty-output",
            code: "AI_PROVIDER_EMPTY_OUTPUT",
            summary: "Fictional provider returned no visible output.",
            retryable: true,
            fallbackAllowed: true,
            countsForDegrade: true,
            durationMs: 8,
          }
        : { status: "succeeded", text: "Recovered answer", durationMs: 8 },
    );
    const service = new AiRoutingService(repository, client, secretResolver());

    await expect(
      service.execute(routeRequest(configuredRoute.id)),
    ).resolves.toMatchObject({
      status: "succeeded",
      text: "Recovered answer",
      attemptCount: 2,
    });
    expect(client.calls).toEqual([primary.id, primary.id]);
    expect(repository.attempts).toMatchObject([
      {
        status: "failed",
        errorCode: "AI_PROVIDER_EMPTY_OUTPUT",
        retryable: true,
        diagnostics: null,
      },
      { status: "succeeded", diagnostics: null },
    ]);
  });

  it("keeps retrying one provider when fallback switching is disabled", async () => {
    const repository = new InMemoryAiRepository();
    const primary = await provider(repository, "primary");
    const configuredRoute = await route(repository, [primary.id], {
      rounds: 2,
      fallbackEnabled: false,
      threshold: 10,
    });
    const client = new FakeAiClient((_, callNumber) =>
      callNumber === 1
        ? {
            status: "failed",
            category: "empty-output",
            code: "AI_PROVIDER_EMPTY_OUTPUT",
            summary: "Fictional provider returned no visible output.",
            retryable: true,
            fallbackAllowed: true,
            countsForDegrade: true,
            durationMs: 8,
          }
        : { status: "succeeded", text: "Recovered answer", durationMs: 8 },
    );
    const service = new AiRoutingService(repository, client, secretResolver());

    await expect(
      service.execute(routeRequest(configuredRoute.id)),
    ).resolves.toMatchObject({
      status: "succeeded",
      text: "Recovered answer",
      attemptCount: 2,
    });
    expect(client.calls).toEqual([primary.id, primary.id]);
  });

  it("keeps the locked route and provider snapshot while an attempt is running", async () => {
    const repository = new InMemoryAiRepository();
    const primary = await provider(repository, "primary");
    const backup = await provider(repository, "backup");
    const configuredRoute = await route(repository, [primary.id, backup.id], {
      rounds: 1,
      threshold: 10,
    });
    const client = new FakeAiClient(async (candidate) => {
      if (candidate.id === primary.id) {
        const providerUpdate = await repository.updateProvider(
          backup.id,
          backup.version,
          {
            name: backup.name,
            apiKind: backup.apiKind,
            baseUrl: backup.baseUrl,
            model: "replacement-model",
            secretRef: backup.secretRef,
            parameters: backup.parameters,
            requestTimeoutMs: backup.requestTimeoutMs,
            enabled: backup.enabled,
          },
        );
        expect(providerUpdate.status).toBe("ok");
        const routeUpdate = await repository.updateRoute(
          configuredRoute.id,
          configuredRoute.version,
          {
            name: configuredRoute.name,
            providerIds: [backup.id, primary.id],
            fallbackEnabled: configuredRoute.fallbackEnabled,
            retryPolicy: configuredRoute.retryPolicy,
            degradePolicy: configuredRoute.degradePolicy,
            enabled: configuredRoute.enabled,
          },
        );
        expect(routeUpdate.status).toBe("ok");
        return timeoutFailure();
      }
      return { status: "succeeded", text: "Stable answer", durationMs: 8 };
    });
    const service = new AiRoutingService(repository, client, secretResolver());

    await expect(
      service.execute(routeRequest(configuredRoute.id)),
    ).resolves.toMatchObject({
      status: "succeeded",
      providerId: backup.id,
      providerVersion: backup.version,
      model: backup.model,
      routeVersion: configuredRoute.version,
    });
    expect(client.calls).toEqual([primary.id, backup.id]);
    expect(client.providerSnapshots[1]).toMatchObject({
      version: backup.version,
      model: backup.model,
    });
    expect(repository.attempts).toMatchObject([
      {
        routeVersion: configuredRoute.version,
        providerVersion: primary.version,
      },
      {
        routeVersion: configuredRoute.version,
        providerVersion: backup.version,
        model: backup.model,
      },
    ]);
  });

  it("does not retry a provider-local permanent failure in the next round", async () => {
    const repository = new InMemoryAiRepository();
    const primary = await provider(repository, "primary");
    const backup = await provider(repository, "backup");
    const configuredRoute = await route(repository, [primary.id, backup.id], {
      rounds: 2,
      threshold: 10,
    });
    const client = new FakeAiClient((candidate) =>
      candidate.id === primary.id
        ? {
            status: "failed",
            category: "authentication",
            code: "AI_PROVIDER_AUTHENTICATION_FAILED",
            summary: "Fictional authentication failure.",
            retryable: false,
            fallbackAllowed: true,
            countsForDegrade: false,
            durationMs: 5,
          }
        : timeoutFailure(),
    );
    const service = new AiRoutingService(repository, client, secretResolver());

    await expect(
      service.execute(routeRequest(configuredRoute.id)),
    ).resolves.toMatchObject({ status: "failed", attemptCount: 3 });
    expect(client.calls).toEqual([primary.id, backup.id, backup.id]);
  });

  it("falls back when a successful response fails the node output contract", async () => {
    const repository = new InMemoryAiRepository();
    const primary = await provider(repository, "primary");
    const backup = await provider(repository, "backup");
    const configuredRoute = await route(repository, [primary.id, backup.id]);
    const client = new FakeAiClient((candidate) => ({
      status: "succeeded",
      text: candidate.id === primary.id ? "not-json" : '{"ok":true}',
      durationMs: 8,
    }));
    const service = new AiRoutingService(repository, client, secretResolver());

    const result = await service.execute({
      ...routeRequest(configuredRoute.id),
      outputFormat: "json",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      providerId: backup.id,
      attemptCount: 2,
    });
    expect(repository.attempts[0]).toMatchObject({
      errorCategory: "invalid-response",
      errorCode: "AI_OUTPUT_INVALID_JSON",
      fallbackAllowed: true,
    });
  });

  it("stops fallback when output discloses a configured secret", async () => {
    const repository = new InMemoryAiRepository();
    const primary = await provider(repository, "primary");
    const backup = await provider(repository, "backup");
    const configuredRoute = await route(repository, [primary.id, backup.id]);
    const client = new FakeAiClient(() => ({
      status: "succeeded",
      text: "Leaked primary-secret",
      durationMs: 8,
    }));
    const service = new AiRoutingService(repository, client, secretResolver());

    await expect(
      service.execute(routeRequest(configuredRoute.id)),
    ).resolves.toMatchObject({
      status: "failed",
      code: "AI_OUTPUT_SECRET_DISCLOSURE",
      attemptCount: 1,
    });
    expect(client.calls).toEqual([primary.id]);
    expect(JSON.stringify(repository.attempts)).not.toContain("primary-secret");
  });

  it("degrades a failed primary and restores it with one half-open probe", async () => {
    let now = Date.parse("2026-08-03T00:00:00.000Z");
    const repository = new InMemoryAiRepository(() => now);
    const primary = await provider(repository, "primary");
    const backup = await provider(repository, "backup");
    const configuredRoute = await route(repository, [primary.id, backup.id], {
      threshold: 1,
      cooldownMs: 1_000,
      rounds: 1,
    });
    let primaryHealthy = false;
    const client = new FakeAiClient((candidate) =>
      candidate.id === primary.id && !primaryHealthy
        ? timeoutFailure()
        : { status: "succeeded", text: "Answer", durationMs: 8 },
    );
    const service = new AiRoutingService(repository, client, secretResolver());

    await service.execute(routeRequest(configuredRoute.id));
    expect(await repository.getProviderHealth(primary.id)).toMatchObject({
      state: "degraded",
      consecutiveFailures: 1,
    });
    await service.execute(routeRequest(configuredRoute.id));
    expect(client.calls).toEqual([primary.id, backup.id, backup.id]);

    now += 1_001;
    primaryHealthy = true;
    await service.execute(routeRequest(configuredRoute.id));
    expect(client.calls.at(-1)).toBe(primary.id);
    expect(await repository.getProviderHealth(primary.id)).toMatchObject({
      state: "healthy",
      consecutiveFailures: 0,
    });
    expect(repository.attempts.at(-1)).toMatchObject({
      providerId: primary.id,
      selectionHealthState: "half-open",
      healthState: "healthy",
      errorCategory: null,
    });
    expect(
      repository.healthEvents.map(({ from, to }) => ({ from, to })),
    ).toEqual([
      { from: "healthy", to: "degraded" },
      { from: "degraded", to: "half-open" },
      { from: "half-open", to: "healthy" },
    ]);
  });

  it("returns any failed half-open probe to cooldown", async () => {
    const repository = new InMemoryAiRepository();
    const primary = await provider(repository, "primary");
    const health = repository.health.get(primary.id);
    if (health === undefined) {
      throw new Error("Health fixture failed.");
    }
    health.state = "half-open";

    await repository.recordProviderFailure({
      providerId: primary.id,
      errorCode: "AI_PROVIDER_AUTHENTICATION_FAILED",
      countsForDegrade: false,
      failureThreshold: 3,
      cooldownMs: 1_000,
    });
    expect(await repository.getProviderHealth(primary.id)).toMatchObject({
      state: "degraded",
      consecutiveFailures: 0,
    });
  });

  it("skips an enabled provider whose server secret is not configured", async () => {
    const repository = new InMemoryAiRepository();
    const primary = await provider(repository, "primary");
    const backup = await provider(repository, "backup");
    const configuredRoute = await route(repository, [primary.id, backup.id]);
    const client = new FakeAiClient(() => ({
      status: "succeeded",
      text: "Backup answer",
      durationMs: 8,
    }));
    const service = new AiRoutingService(
      repository,
      client,
      new EnvironmentSecretResolver({ BACKUP_KEY: "backup-secret" }),
    );

    await expect(
      service.execute(routeRequest(configuredRoute.id)),
    ).resolves.toMatchObject({
      status: "succeeded",
      providerId: backup.id,
      attemptCount: 1,
    });
    expect(client.calls).toEqual([backup.id]);
    expect(repository.attempts).toMatchObject([
      { providerId: backup.id, round: 1, sequence: 1 },
    ]);
  });

  it("claims at most one half-open probe across an exhausted route", async () => {
    const now = Date.parse("2026-08-03T00:00:00.000Z");
    const repository = new InMemoryAiRepository(() => now);
    const primary = await provider(repository, "primary");
    const backup = await provider(repository, "backup");
    const configuredRoute = await route(repository, [primary.id, backup.id]);
    for (const candidate of [primary, backup]) {
      const health = repository.health.get(candidate.id);
      if (health !== undefined) {
        health.state = "degraded";
        health.degradedUntil = new Date(now - 1).toISOString();
      }
    }
    const snapshot = await repository.getRouteSnapshot(configuredRoute.id);
    if (snapshot === null) {
      throw new Error("Route snapshot fixture failed.");
    }

    const first = await repository.selectCandidates(snapshot);
    const claimed = await repository.claimProviderProbe(
      first.candidates[0]?.provider.id ?? "",
      snapshot.providers.map((provider) => provider.id),
    );
    const concurrent = await repository.selectCandidates(snapshot);
    expect(first.candidates).toHaveLength(1);
    expect(first.candidates[0]).toMatchObject({ healthState: "degraded" });
    expect(claimed).toMatchObject({ state: "half-open" });
    expect(concurrent.candidates).toHaveLength(0);
  });
});
