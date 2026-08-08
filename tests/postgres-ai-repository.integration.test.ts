import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresAiRepository } from "../modules/ai/postgres-ai-repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(testDatabaseUrl !== undefined)("PostgresAiRepository", () => {
  let repository: PostgresAiRepository;
  let inspectionPool: Pool;

  beforeAll(() => {
    repository = new PostgresAiRepository(testDatabaseUrl ?? "");
    inspectionPool = new Pool({ connectionString: testDatabaseUrl });
  });

  afterAll(async () => {
    await Promise.all([repository.close(), inspectionPool.end()]);
  });

  it("persists provider order, current route configuration, and health independently", async () => {
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

    const storedRouteVersions = await inspectionPool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ai_provider_route_versions WHERE route_id = $1",
      [route.value.id],
    );
    expect(storedRouteVersions.rows[0]?.count).toBe("1");

    const workflowId = randomUUID();
    const workflowVersionId = randomUUID();
    await inspectionPool.query(
      "INSERT INTO workflows (id, name, status) VALUES ($1, $2, 'active')",
      [workflowId, `Workflow ${suffix}`],
    );
    await inspectionPool.query(
      `INSERT INTO workflow_versions (
         id, workflow_id, version, status, definition, published_at
       ) VALUES ($1, $2, 1, 'published', $3::jsonb, NOW())`,
      [
        workflowVersionId,
        workflowId,
        JSON.stringify({
          schemaVersion: "1",
          name: "route-reference",
          startNodeId: "ai",
          maxSteps: 8,
          nodes: [
            {
              id: "ai",
              type: "ai-chat",
              version: 1,
              config: { providerRouteId: route.value.id },
            },
          ],
        }),
      ],
    );
    await inspectionPool.query(
      "UPDATE workflows SET published_version_id = $2 WHERE id = $1",
      [workflowId, workflowVersionId],
    );

    const triggerId = randomUUID();
    const diagnosticExecutionId = randomUUID();
    await inspectionPool.query(
      `INSERT INTO bot_triggers (id, name, workflow_version_id, conditions, enabled)
       VALUES ($1, $2, $3, '{}'::jsonb, TRUE)`,
      [triggerId, `Trigger ${suffix}`, workflowVersionId],
    );
    await inspectionPool.query(
      `INSERT INTO workflow_executions (
         id, provider, external_event_id, trigger_id, workflow_version_id,
         correlation_id, status
       ) VALUES ($1, 'fictional', $2, $3, $4, $5, 'running')`,
      [
        diagnosticExecutionId,
        `event-${suffix}`,
        triggerId,
        workflowVersionId,
        randomUUID(),
      ],
    );
    await repository.recordAttempt({
      executionId: diagnosticExecutionId,
      nodeId: "ai-node",
      routeId: route.value.id,
      routeVersion: route.value.version,
      providerId: primary.value.id,
      providerName: primary.value.name,
      providerVersion: primary.value.version,
      model: primary.value.model,
      agentTurn: 1,
      round: 1,
      sequence: 1,
      status: "succeeded",
      selectionHealthState: "healthy",
      healthState: "healthy",
      durationMs: 123,
      errorCategory: null,
      errorCode: null,
      retryable: null,
      fallbackAllowed: null,
      diagnostics: {
        clientRequestId: `${diagnosticExecutionId}:ai-node:1:1`,
        providerRequestId: "provider-request-fictional",
        httpStatus: 200,
        requestHash: "request-hash-fictional",
        requestMessageCount: 3,
        requestCharacters: 420,
        responseBytes: 512,
        responseBodyHash: "response-hash-fictional",
        responseFinishReason: "stop",
        responseContentCharacters: 64,
        responseReasoningCharacters: 0,
        promptTokens: 300,
        completionTokens: 64,
        reasoningTokens: 0,
        totalTokens: 364,
        cachedPromptTokens: 256,
        cacheWritePromptTokens: 0,
        cacheMissPromptTokens: 44,
      },
    });
    await expect(
      repository.listAttempts(diagnosticExecutionId, "ai-node"),
    ).resolves.toMatchObject([
      {
        executionId: diagnosticExecutionId,
        diagnostics: {
          providerRequestId: "provider-request-fictional",
          requestHash: "request-hash-fictional",
          requestMessageCount: 3,
          promptTokens: 300,
          cachedPromptTokens: 256,
          cacheMissPromptTokens: 44,
        },
      },
    ]);
    await repository.recordToolExecution({
      executionId: diagnosticExecutionId,
      nodeId: "ai-node",
      providerId: primary.value.id,
      toolCallId: "fictional-tool-call",
      toolName: "web_search",
      status: "succeeded",
      durationMs: 42,
      resultCount: 1,
      queryHash: "a".repeat(64),
      errorCode: null,
      requestDetails: {
        query: "fictional latest news",
        language: "zh-CN",
      },
      responseDetails: {
        retainedResultCount: 1,
        results: [
          {
            title: "Fictional result",
            url: "https://news.example.test/fictional",
          },
        ],
      },
    });
    await expect(
      repository.listToolExecutions(diagnosticExecutionId, "ai-node"),
    ).resolves.toMatchObject([
      {
        executionId: diagnosticExecutionId,
        toolName: "web_search",
        status: "succeeded",
        resultCount: 1,
        queryHash: "a".repeat(64),
        requestDetails: {
          query: "fictional latest news",
          language: "zh-CN",
        },
        responseDetails: {
          retainedResultCount: 1,
        },
      },
    ]);
    await inspectionPool.query(
      "DELETE FROM workflow_executions WHERE id = $1",
      [diagnosticExecutionId],
    );
    await inspectionPool.query("DELETE FROM bot_triggers WHERE id = $1", [
      triggerId,
    ]);

    await expect(
      repository.deleteRoute(route.value.id, updated.value.version),
    ).resolves.toMatchObject({
      status: "conflict",
      reason: "The AI provider route is used by an active workflow.",
    });

    await inspectionPool.query(
      `UPDATE workflows
       SET status = 'inactive', published_version_id = NULL
       WHERE id = $1`,
      [workflowId],
    );
    await inspectionPool.query(
      "UPDATE workflow_versions SET status = 'superseded' WHERE id = $1",
      [workflowVersionId],
    );
    await expect(
      repository.deleteRoute(route.value.id, updated.value.version),
    ).resolves.toMatchObject({ status: "ok" });

    await inspectionPool.query("DELETE FROM workflows WHERE id = $1", [
      workflowId,
    ]);

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
