import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresAiRepository } from "../modules/ai/postgres-ai-repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(testDatabaseUrl !== undefined)("PostgresAiRepository", () => {
  let repository: PostgresAiRepository;

  beforeAll(() => {
    repository = new PostgresAiRepository(testDatabaseUrl ?? "");
  });

  afterAll(async () => {
    await repository.close();
  });

  it("persists provider order, route versions, and health independently", async () => {
    const suffix = randomUUID();
    const primary = await repository.createProvider({
      name: `Primary ${suffix}`,
      apiKind: "chat-completions",
      baseUrl: "https://primary.example.test/v1",
      model: "fictional-primary",
      secretRef: "FICTIONAL_PRIMARY_KEY",
      parameters: {},
      requestTimeoutMs: 5_000,
      enabled: true,
    });
    const backup = await repository.createProvider({
      name: `Backup ${suffix}`,
      apiKind: "responses",
      baseUrl: "https://backup.example.test/v1",
      model: "fictional-backup",
      secretRef: "FICTIONAL_BACKUP_KEY",
      parameters: { top_p: 0.8 },
      requestTimeoutMs: 5_000,
      enabled: true,
    });
    expect(primary.status).toBe("ok");
    expect(backup.status).toBe("ok");
    if (primary.status !== "ok" || backup.status !== "ok") {
      return;
    }

    const reordered = await repository.reorderProviders([
      { id: backup.value.id, expectedVersion: backup.value.version },
      { id: primary.value.id, expectedVersion: primary.value.version },
      ...(await repository.listProviders())
        .filter(
          (provider) =>
            provider.id !== primary.value.id && provider.id !== backup.value.id,
        )
        .map((provider) => ({
          id: provider.id,
          expectedVersion: provider.version,
        })),
    ]);
    expect(reordered.status).toBe("ok");
    if (reordered.status !== "ok") {
      return;
    }
    expect(reordered.value.slice(0, 2).map((provider) => provider.id)).toEqual([
      backup.value.id,
      primary.value.id,
    ]);

    const route = await repository.createRoute({
      name: `Route ${suffix}`,
      providerIds: [primary.value.id, backup.value.id],
      fallbackEnabled: true,
      retryPolicy: { maxRounds: 2, initialDelayMs: 0 },
      degradePolicy: { failureThreshold: 1, cooldownMs: 1_000 },
      enabled: true,
    });
    expect(route.status).toBe("ok");
    if (route.status !== "ok") {
      return;
    }

    const degraded = await repository.recordProviderFailure({
      providerId: primary.value.id,
      errorCode: "AI_PROVIDER_TIMEOUT",
      countsForDegrade: true,
      failureThreshold: 1,
      cooldownMs: 1_000,
    });
    expect(degraded).toMatchObject({
      state: "degraded",
      consecutiveFailures: 1,
    });
    await expect(
      repository.resetProviderHealth(primary.value.id),
    ).resolves.toMatchObject({ state: "healthy", consecutiveFailures: 0 });

    const updated = await repository.updateRoute(
      route.value.id,
      route.value.version,
      {
        name: route.value.name,
        providerIds: [backup.value.id, primary.value.id],
        fallbackEnabled: true,
        retryPolicy: { maxRounds: 3, initialDelayMs: 10 },
        degradePolicy: { failureThreshold: 2, cooldownMs: 2_000 },
        enabled: true,
      },
    );
    expect(updated).toMatchObject({
      status: "ok",
      value: { version: 2, providerIds: [backup.value.id, primary.value.id] },
    });
    if (updated.status !== "ok") {
      return;
    }
    await expect(
      repository.deleteRoute(route.value.id, updated.value.version),
    ).resolves.toMatchObject({ status: "ok" });

    const current = new Map(
      (await repository.listProviders()).map((provider) => [
        provider.id,
        provider,
      ]),
    );
    await expect(
      repository.deleteProvider(
        primary.value.id,
        current.get(primary.value.id)?.version ?? -1,
      ),
    ).resolves.toMatchObject({ status: "ok" });
    await expect(
      repository.deleteProvider(
        backup.value.id,
        current.get(backup.value.id)?.version ?? -1,
      ),
    ).resolves.toMatchObject({ status: "ok" });
  });
});
