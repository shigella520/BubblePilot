import { randomUUID } from "node:crypto";

import type {
  AiMutationResult,
  AiRepository,
} from "../../modules/ai/ai-repository.js";
import type {
  AiAttemptRecordInput,
  AiCandidate,
  AiCandidateSelection,
  AiProviderAttemptView,
  AiImageInputRecordInput,
  AiImageInputView,
  AiProviderCapabilityProbe,
  AiProviderConfiguration,
  AiProviderHealth,
  AiProviderRecord,
  AiProviderRouteRecord,
  AiRouteConfiguration,
  AiRouteSnapshot,
  AiToolExecutionRecordInput,
  AiToolExecutionView,
  AiUsageHours,
  AiUsageReport,
} from "../../modules/ai/ai-types.js";

function cloned<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryAiRepository implements AiRepository {
  private readonly halfOpenClaims = new Map<string, number>();
  readonly providers = new Map<string, AiProviderRecord>();
  readonly health = new Map<string, AiProviderHealth>();
  readonly routes = new Map<string, AiProviderRouteRecord>();
  readonly attempts: AiProviderAttemptView[] = [];
  readonly toolExecutions: AiToolExecutionView[] = [];
  readonly imageInputs: AiImageInputView[] = [];
  usageReport: AiUsageReport | null = null;
  readonly healthEvents: Array<{
    providerId: string;
    from: AiProviderHealth["state"];
    to: AiProviderHealth["state"];
    reason: string;
  }> = [];

  constructor(private readonly now: () => number = Date.now) {}

  listProviders(): Promise<readonly AiProviderRecord[]> {
    return Promise.resolve(
      [...this.providers.values()]
        .sort(
          (left, right) =>
            left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
        )
        .map(cloned),
    );
  }

  getProvider(providerId: string): Promise<AiProviderRecord | null> {
    const provider = this.providers.get(providerId);
    return Promise.resolve(provider === undefined ? null : cloned(provider));
  }

  updateProviderCapabilityProbe(
    providerId: string,
    probe: AiProviderCapabilityProbe,
  ): Promise<AiProviderRecord | null> {
    const provider = this.providers.get(providerId);
    if (provider === undefined) return Promise.resolve(null);
    provider.capabilityProbe = cloned(probe);
    return Promise.resolve(cloned(provider));
  }

  async createProvider(
    configuration: AiProviderConfiguration,
  ): Promise<AiMutationResult<AiProviderRecord>> {
    if (this.providers.size >= 100) {
      return {
        status: "conflict",
        reason: "At most 100 active AI providers can be configured.",
      };
    }
    if (this.providerNameExists(configuration.name)) {
      return { status: "conflict", reason: "Provider name already exists." };
    }
    const timestamp = this.timestamp();
    const provider: AiProviderRecord = {
      ...cloned(configuration),
      id: randomUUID(),
      sortOrder:
        Math.max(
          0,
          ...[...this.providers.values()].map((item) => item.sortOrder),
        ) + 100,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.providers.set(provider.id, provider);
    this.health.set(provider.id, {
      providerId: provider.id,
      state: "healthy",
      consecutiveFailures: 0,
      degradedUntil: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorCode: null,
      version: 1,
      updatedAt: timestamp,
    });
    return { status: "ok", value: cloned(provider) };
  }

  async updateProvider(
    providerId: string,
    expectedVersion: number,
    configuration: AiProviderConfiguration,
  ): Promise<AiMutationResult<AiProviderRecord>> {
    const provider = this.providers.get(providerId);
    if (provider === undefined) {
      return { status: "not-found" };
    }
    if (provider.version !== expectedVersion) {
      return { status: "conflict", reason: "Provider version is stale." };
    }
    if (this.providerNameExists(configuration.name, providerId)) {
      return { status: "conflict", reason: "Provider name already exists." };
    }
    Object.assign(provider, cloned(configuration), {
      version: provider.version + 1,
      updatedAt: this.timestamp(),
    });
    return { status: "ok", value: cloned(provider) };
  }

  async setProviderEnabled(
    providerId: string,
    expectedVersion: number,
    enabled: boolean,
  ): Promise<AiMutationResult<AiProviderRecord>> {
    const provider = this.providers.get(providerId);
    if (provider === undefined) {
      return { status: "not-found" };
    }
    if (provider.version !== expectedVersion) {
      return { status: "conflict", reason: "Provider version is stale." };
    }
    provider.enabled = enabled;
    provider.version += 1;
    provider.updatedAt = this.timestamp();
    return { status: "ok", value: cloned(provider) };
  }

  async reorderProviders(
    providers: readonly { id: string; expectedVersion: number }[],
  ): Promise<AiMutationResult<readonly AiProviderRecord[]>> {
    if (
      new Set(providers.map((provider) => provider.id)).size !==
        providers.length ||
      providers.length !== this.providers.size ||
      providers.some(
        (expected) =>
          this.providers.get(expected.id)?.version !== expected.expectedVersion,
      )
    ) {
      return { status: "conflict", reason: "Provider order payload is stale." };
    }
    for (const [index, expected] of providers.entries()) {
      const provider = this.providers.get(expected.id);
      if (provider !== undefined) {
        provider.sortOrder = (index + 1) * 100;
        provider.version += 1;
        provider.updatedAt = this.timestamp();
      }
    }
    return { status: "ok", value: await this.listProviders() };
  }

  async deleteProvider(
    providerId: string,
    expectedVersion: number,
  ): Promise<AiMutationResult<AiProviderRecord>> {
    const provider = this.providers.get(providerId);
    if (provider === undefined) {
      return { status: "not-found" };
    }
    if (provider.version !== expectedVersion) {
      return { status: "conflict", reason: "Provider version is stale." };
    }
    if (
      [...this.routes.values()].some((route) =>
        route.providerIds.includes(providerId),
      )
    ) {
      return {
        status: "conflict",
        reason: "Provider is referenced by a route.",
      };
    }
    provider.enabled = false;
    provider.version += 1;
    provider.updatedAt = this.timestamp();
    this.providers.delete(providerId);
    return { status: "ok", value: cloned(provider) };
  }

  getProviderHealth(providerId: string): Promise<AiProviderHealth | null> {
    const value = this.health.get(providerId);
    return Promise.resolve(value === undefined ? null : cloned(value));
  }

  async resetProviderHealth(
    providerId: string,
  ): Promise<AiProviderHealth | null> {
    const health = this.health.get(providerId);
    if (health === undefined) {
      return null;
    }
    this.transition(health, "healthy", "manual-reset");
    Object.assign(health, {
      consecutiveFailures: 0,
      degradedUntil: null,
      lastErrorCode: null,
      version: health.version + 1,
      updatedAt: this.timestamp(),
    });
    this.halfOpenClaims.delete(providerId);
    return cloned(health);
  }

  async recordProviderSuccess(providerId: string): Promise<AiProviderHealth> {
    const health = this.requiredHealth(providerId);
    this.transition(health, "healthy", "request-succeeded");
    Object.assign(health, {
      consecutiveFailures: 0,
      degradedUntil: null,
      lastSuccessAt: this.timestamp(),
      lastErrorCode: null,
      version: health.version + 1,
      updatedAt: this.timestamp(),
    });
    this.halfOpenClaims.delete(providerId);
    return cloned(health);
  }

  async recordProviderFailure(input: {
    providerId: string;
    errorCode: string;
    countsForDegrade: boolean;
    failureThreshold: number;
    cooldownMs: number;
  }): Promise<AiProviderHealth> {
    const health = this.requiredHealth(input.providerId);
    const failures = input.countsForDegrade
      ? health.consecutiveFailures + 1
      : health.consecutiveFailures;
    const degrade =
      health.state === "half-open" ||
      (input.countsForDegrade && failures >= input.failureThreshold);
    if (degrade) {
      const reason =
        health.state === "half-open"
          ? "half-open-probe-failed"
          : "failure-threshold";
      this.transition(health, "degraded", reason);
    }
    Object.assign(health, {
      consecutiveFailures: failures,
      degradedUntil: degrade
        ? new Date(this.now() + input.cooldownMs).toISOString()
        : health.degradedUntil,
      lastFailureAt: this.timestamp(),
      lastErrorCode: input.errorCode,
      version: health.version + 1,
      updatedAt: this.timestamp(),
    });
    if (degrade) {
      this.halfOpenClaims.delete(input.providerId);
    }
    return cloned(health);
  }

  listRoutes(): Promise<readonly AiProviderRouteRecord[]> {
    return Promise.resolve(
      [...this.routes.values()]
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            left.id.localeCompare(right.id),
        )
        .map(cloned),
    );
  }

  getRoute(routeId: string): Promise<AiProviderRouteRecord | null> {
    const route = this.routes.get(routeId);
    return Promise.resolve(route === undefined ? null : cloned(route));
  }

  async createRoute(
    configuration: AiRouteConfiguration,
  ): Promise<AiMutationResult<AiProviderRouteRecord>> {
    if (this.routeNameExists(configuration.name)) {
      return { status: "conflict", reason: "Route name already exists." };
    }
    if (!this.validRouteProviders(configuration.providerIds)) {
      return { status: "conflict", reason: "Route providers are invalid." };
    }
    const timestamp = this.timestamp();
    const route: AiProviderRouteRecord = {
      ...cloned(configuration),
      id: randomUUID(),
      versionId: randomUUID(),
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.routes.set(route.id, route);
    return { status: "ok", value: cloned(route) };
  }

  async updateRoute(
    routeId: string,
    expectedVersion: number,
    configuration: AiRouteConfiguration,
  ): Promise<AiMutationResult<AiProviderRouteRecord>> {
    const route = this.routes.get(routeId);
    if (route === undefined) {
      return { status: "not-found" };
    }
    if (route.version !== expectedVersion) {
      return { status: "conflict", reason: "Route version is stale." };
    }
    if (
      this.routeNameExists(configuration.name, routeId) ||
      !this.validRouteProviders(configuration.providerIds)
    ) {
      return { status: "conflict", reason: "Route configuration conflicts." };
    }
    Object.assign(route, cloned(configuration), {
      versionId: randomUUID(),
      version: route.version + 1,
      updatedAt: this.timestamp(),
    });
    return { status: "ok", value: cloned(route) };
  }

  async setRouteEnabled(
    routeId: string,
    expectedVersion: number,
    enabled: boolean,
  ): Promise<AiMutationResult<AiProviderRouteRecord>> {
    const route = this.routes.get(routeId);
    if (route === undefined) {
      return { status: "not-found" };
    }
    return this.updateRoute(routeId, expectedVersion, { ...route, enabled });
  }

  async deleteRoute(
    routeId: string,
    expectedVersion: number,
  ): Promise<AiMutationResult<AiProviderRouteRecord>> {
    const route = this.routes.get(routeId);
    if (route === undefined) {
      return { status: "not-found" };
    }
    if (route.version !== expectedVersion) {
      return { status: "conflict", reason: "Route version is stale." };
    }
    this.routes.delete(routeId);
    return { status: "ok", value: cloned(route) };
  }

  async getRouteSnapshot(routeId: string): Promise<AiRouteSnapshot | null> {
    const route = this.routes.get(routeId);
    if (route === undefined || !route.enabled) {
      return null;
    }
    const providers =
      route.providerIds.length === 0
        ? await this.listProviders()
        : route.providerIds.flatMap((providerId) => {
            const provider = this.providers.get(providerId);
            return provider === undefined ? [] : [cloned(provider)];
          });
    return {
      route: cloned(route),
      providers: providers.filter((provider) => provider.enabled),
    };
  }

  async selectCandidates(
    snapshot: AiRouteSnapshot,
  ): Promise<AiCandidateSelection> {
    const now = this.now();
    const reclaimBefore = now - 120_000;
    const activeHalfOpen = snapshot.providers.some(
      (provider) =>
        this.health.get(provider.id)?.state === "half-open" &&
        (this.halfOpenClaims.get(provider.id) ?? 0) > reclaimBefore,
    );
    const eligible = activeHalfOpen
      ? undefined
      : snapshot.providers.find((provider) => {
          const health = this.health.get(provider.id);
          return (
            (health?.state === "degraded" &&
              health.degradedUntil !== null &&
              Date.parse(health.degradedUntil) <= now) ||
            (health?.state === "half-open" &&
              (this.halfOpenClaims.get(provider.id) ?? 0) <= reclaimBefore)
          );
        });
    const candidates: AiCandidate[] = snapshot.providers.flatMap((provider) => {
      const health = this.health.get(provider.id);
      return health?.state === "healthy" || provider.id === eligible?.id
        ? [
            {
              provider: cloned(provider),
              healthState: health?.state ?? "healthy",
            },
          ]
        : [];
    });
    const nextAvailable = snapshot.providers
      .flatMap((provider) => {
        const health = this.health.get(provider.id);
        if (health?.state === "degraded" && health.degradedUntil !== null) {
          return [health.degradedUntil];
        }
        if (health?.state === "half-open") {
          const claimedAt = this.halfOpenClaims.get(provider.id);
          return claimedAt === undefined
            ? []
            : [new Date(claimedAt + 120_000).toISOString()];
        }
        return [];
      })
      .sort()[0];
    return { candidates, nextAvailableAt: nextAvailable ?? null };
  }

  claimProviderProbe(
    providerId: string,
    candidateProviderIds: readonly string[],
  ): Promise<AiProviderHealth | null> {
    const now = this.now();
    const reclaimBefore = now - 120_000;
    const activeHalfOpen = candidateProviderIds.some(
      (candidateId) =>
        this.health.get(candidateId)?.state === "half-open" &&
        (this.halfOpenClaims.get(candidateId) ?? 0) > reclaimBefore,
    );
    const health = this.health.get(providerId);
    const eligible =
      !activeHalfOpen &&
      ((health?.state === "degraded" &&
        health.degradedUntil !== null &&
        Date.parse(health.degradedUntil) <= now) ||
        (health?.state === "half-open" &&
          (this.halfOpenClaims.get(providerId) ?? 0) <= reclaimBefore));
    if (!eligible || health === undefined) {
      return Promise.resolve(null);
    }
    this.transition(health, "half-open", "cooldown-probe");
    this.halfOpenClaims.set(providerId, now);
    health.version += 1;
    health.updatedAt = this.timestamp();
    return Promise.resolve(cloned(health));
  }

  recordAttempt(input: AiAttemptRecordInput): Promise<void> {
    this.attempts.push({
      ...cloned(input),
      id: randomUUID(),
      createdAt: this.timestamp(),
    });
    return Promise.resolve();
  }

  listAttempts(
    executionId: string,
    nodeId?: string,
  ): Promise<readonly AiProviderAttemptView[]> {
    return Promise.resolve(
      this.attempts
        .filter(
          (attempt) =>
            attempt.executionId === executionId &&
            (nodeId === undefined || attempt.nodeId === nodeId),
        )
        .sort(
          (left, right) =>
            left.agentTurn - right.agentTurn ||
            left.round - right.round ||
            left.sequence - right.sequence,
        )
        .map(cloned),
    );
  }

  async getUsage(input: {
    hours: AiUsageHours;
    timeZone: string;
    now: Date;
  }): Promise<AiUsageReport> {
    if (this.usageReport !== null) return cloned(this.usageReport);
    const providers = await this.listProviders();
    const emptyMetrics = {
      requestCount: 0,
      succeededRequestCount: 0,
      failedRequestCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      cachedPromptTokens: null,
      cacheEligiblePromptTokens: 0,
      cacheHitRate: null,
      cacheDataCoverage: null,
    } as const;
    return {
      generatedAt: input.now.toISOString(),
      timeZone: input.timeZone,
      hours: input.hours,
      bucketMinutes:
        input.hours === 1
          ? 1
          : input.hours === 6
            ? 5
            : input.hours === 48
              ? 30
              : 15,
      providers: providers.map(({ id, name }) => ({ id, name })),
      periods: providers.map(({ id, name }) => ({
        providerId: id,
        providerName: name,
        today: emptyMetrics,
        week: emptyMetrics,
        month: emptyMetrics,
      })),
      series: [],
    };
  }

  recordToolExecution(input: AiToolExecutionRecordInput): Promise<void> {
    this.toolExecutions.push({
      ...cloned(input),
      id: randomUUID(),
      createdAt: this.timestamp(),
    });
    return Promise.resolve();
  }

  listToolExecutions(
    executionId: string,
    nodeId?: string,
  ): Promise<readonly AiToolExecutionView[]> {
    return Promise.resolve(
      this.toolExecutions
        .filter(
          (item) =>
            item.executionId === executionId &&
            (nodeId === undefined || item.nodeId === nodeId),
        )
        .map(cloned),
    );
  }

  recordImageInput(input: AiImageInputRecordInput): Promise<void> {
    this.imageInputs.push({
      ...cloned(input),
      id: randomUUID(),
      createdAt: this.timestamp(),
    });
    return Promise.resolve();
  }

  listImageInputs(
    executionId: string,
    nodeId?: string,
  ): Promise<readonly AiImageInputView[]> {
    return Promise.resolve(
      this.imageInputs
        .filter(
          (item) =>
            item.executionId === executionId &&
            (nodeId === undefined || item.nodeId === nodeId),
        )
        .map(cloned),
    );
  }

  isReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private requiredHealth(providerId: string): AiProviderHealth {
    const value = this.health.get(providerId);
    if (value === undefined) {
      throw new Error(`AI provider health '${providerId}' does not exist.`);
    }
    return value;
  }

  private transition(
    health: AiProviderHealth,
    next: AiProviderHealth["state"],
    reason: string,
  ): void {
    if (health.state === next) {
      return;
    }
    this.healthEvents.push({
      providerId: health.providerId,
      from: health.state,
      to: next,
      reason,
    });
    health.state = next;
  }

  private providerNameExists(name: string, exceptId?: string): boolean {
    return [...this.providers.values()].some(
      (provider) =>
        provider.id !== exceptId &&
        provider.name.toLocaleLowerCase("en-US") ===
          name.toLocaleLowerCase("en-US"),
    );
  }

  private routeNameExists(name: string, exceptId?: string): boolean {
    return [...this.routes.values()].some(
      (route) =>
        route.id !== exceptId &&
        route.name.toLocaleLowerCase("en-US") ===
          name.toLocaleLowerCase("en-US"),
    );
  }

  private validRouteProviders(providerIds: readonly string[]): boolean {
    return (
      new Set(providerIds).size === providerIds.length &&
      providerIds.every((providerId) => this.providers.has(providerId))
    );
  }
}
