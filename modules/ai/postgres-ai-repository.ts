import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type { AiMutationResult, AiRepository } from "./ai-repository.js";
import { SettingsCipher } from "../integrations/bluebubbles/settings-cipher.js";
import {
  aiRouteDegradePolicySchema,
  aiRouteRetryPolicySchema,
  type AiAttemptRecordInput,
  type AiCandidate,
  type AiCandidateSelection,
  type AiFailureCategory,
  type AiProviderAttemptView,
  type AiProviderConfiguration,
  type AiProviderHealth,
  type AiProviderHealthState,
  type AiProviderRecord,
  type AiProviderRouteRecord,
  type AiRouteConfiguration,
  type AiRouteSnapshot,
} from "./ai-types.js";

interface ProviderRow {
  id: string;
  name: string;
  api_kind: "chat-completions" | "responses";
  base_url: string;
  model: string;
  secret_ref: string;
  encrypted_secret: string | null;
  parameters: Record<string, string | number | boolean>;
  request_timeout_ms: number;
  enabled: boolean;
  sort_order: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface HealthRow {
  provider_id: string;
  state: AiProviderHealthState;
  consecutive_failures: number;
  degraded_until: Date | null;
  half_open_claimed_at: Date | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_error_code: string | null;
  version: number;
  updated_at: Date;
}

interface RouteRow {
  id: string;
  name: string;
  enabled: boolean;
  version_id: string;
  version: number;
  fallback_enabled: boolean;
  retry_policy: unknown;
  degrade_policy: unknown;
  provider_ids: string[];
  created_at: Date;
  updated_at: Date;
}

interface AttemptRow {
  id: string;
  execution_id: string;
  node_id: string;
  route_id: string;
  route_version: number;
  provider_id: string;
  provider_name: string;
  provider_version: number;
  model: string;
  round: number;
  sequence: number;
  status: "succeeded" | "failed";
  selection_health_state: AiProviderHealthState;
  health_state: AiProviderHealthState;
  duration_ms: number;
  error_category: AiFailureCategory | null;
  error_code: string | null;
  retryable: boolean | null;
  fallback_allowed: boolean | null;
  client_request_id: string | null;
  provider_request_id: string | null;
  http_status: number | null;
  request_hash: string | null;
  request_message_count: number | null;
  request_characters: number | null;
  response_bytes: number | null;
  response_body_hash: string | null;
  response_finish_reason: string | null;
  response_content_characters: number | null;
  response_reasoning_characters: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  cached_prompt_tokens: number | null;
  cache_write_prompt_tokens: number | null;
  cache_miss_prompt_tokens: number | null;
  created_at: Date;
}

const providerSelect = `SELECT
  id, name, api_kind, base_url, model, secret_ref, encrypted_secret, parameters,
  request_timeout_ms, enabled, sort_order, version, created_at, updated_at
FROM ai_providers`;

const routeSelect = `SELECT
  r.id, r.name, r.enabled, rv.id AS version_id, rv.version,
  rv.fallback_enabled, rv.retry_policy, rv.degrade_policy,
  COALESCE(
    ARRAY_AGG(m.provider_id ORDER BY m.position)
      FILTER (WHERE m.provider_id IS NOT NULL),
    ARRAY[]::uuid[]
  ) AS provider_ids,
  r.created_at, r.updated_at
FROM ai_provider_routes r
INNER JOIN ai_provider_route_versions rv ON rv.id = r.current_version_id
LEFT JOIN ai_provider_route_members m ON m.route_version_id = rv.id`;

function providerRecord(
  row: ProviderRow,
  cipher: SettingsCipher,
): AiProviderRecord {
  return {
    id: row.id,
    name: row.name,
    apiKind: row.api_kind,
    baseUrl: row.base_url,
    model: row.model,
    secretRef: row.secret_ref,
    secret:
      row.encrypted_secret === null
        ? null
        : cipher.decrypt(row.encrypted_secret),
    parameters: row.parameters,
    requestTimeoutMs: row.request_timeout_ms,
    enabled: row.enabled,
    sortOrder: row.sort_order,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function healthRecord(row: HealthRow): AiProviderHealth {
  return {
    providerId: row.provider_id,
    state: row.state,
    consecutiveFailures: row.consecutive_failures,
    degradedUntil: row.degraded_until?.toISOString() ?? null,
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    lastFailureAt: row.last_failure_at?.toISOString() ?? null,
    lastErrorCode: row.last_error_code,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

function routeRecord(row: RouteRow): AiProviderRouteRecord {
  return {
    id: row.id,
    name: row.name,
    providerIds: row.provider_ids,
    fallbackEnabled: row.fallback_enabled,
    retryPolicy: aiRouteRetryPolicySchema.parse(row.retry_policy),
    degradePolicy: aiRouteDegradePolicySchema.parse(row.degrade_policy),
    enabled: row.enabled,
    versionId: row.version_id,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function attemptView(row: AttemptRow): AiProviderAttemptView {
  return {
    id: row.id,
    executionId: row.execution_id,
    nodeId: row.node_id,
    routeId: row.route_id,
    routeVersion: row.route_version,
    providerId: row.provider_id,
    providerName: row.provider_name,
    providerVersion: row.provider_version,
    model: row.model,
    round: row.round,
    sequence: row.sequence,
    status: row.status,
    selectionHealthState: row.selection_health_state,
    healthState: row.health_state,
    durationMs: row.duration_ms,
    errorCategory: row.error_category,
    errorCode: row.error_code,
    retryable: row.retryable,
    fallbackAllowed: row.fallback_allowed,
    diagnostics:
      row.request_hash === null
        ? null
        : {
            clientRequestId: row.client_request_id,
            providerRequestId: row.provider_request_id,
            httpStatus: row.http_status,
            requestHash: row.request_hash,
            requestMessageCount: row.request_message_count ?? 0,
            requestCharacters: row.request_characters ?? 0,
            responseBytes: row.response_bytes,
            responseBodyHash: row.response_body_hash,
            responseFinishReason: row.response_finish_reason,
            responseContentCharacters: row.response_content_characters,
            responseReasoningCharacters: row.response_reasoning_characters,
            promptTokens: row.prompt_tokens,
            completionTokens: row.completion_tokens,
            reasoningTokens: row.reasoning_tokens,
            totalTokens: row.total_tokens,
            cachedPromptTokens: row.cached_prompt_tokens,
            cacheWritePromptTokens: row.cache_write_prompt_tokens,
            cacheMissPromptTokens: row.cache_miss_prompt_tokens,
          },
    createdAt: row.created_at.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

function conflict<T>(reason: string): AiMutationResult<T> {
  return { status: "conflict", reason };
}

export class PostgresAiRepository implements AiRepository {
  private readonly pool: Pool;
  private readonly cipher: SettingsCipher;

  constructor(databaseUrl: string, settingsEncryptionKey?: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
    this.cipher = new SettingsCipher(
      settingsEncryptionKey ??
        process.env.API_ACCESS_TOKEN ??
        "legacy-ai-provider-key",
    );
  }

  async listProviders(): Promise<readonly AiProviderRecord[]> {
    const result = await this.pool.query<ProviderRow>(
      `${providerSelect}
       WHERE deleted_at IS NULL
       ORDER BY sort_order, id`,
    );
    return result.rows.map((row) => providerRecord(row, this.cipher));
  }

  async getProvider(providerId: string): Promise<AiProviderRecord | null> {
    const result = await this.pool.query<ProviderRow>(
      `${providerSelect} WHERE id = $1 AND deleted_at IS NULL`,
      [providerId],
    );
    const row = result.rows[0];
    return row === undefined ? null : providerRecord(row, this.cipher);
  }

  async createProvider(
    configuration: AiProviderConfiguration,
  ): Promise<AiMutationResult<AiProviderRecord>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE ai_providers IN SHARE ROW EXCLUSIVE MODE");
      const order = await client.query<{
        sort_order: number;
        provider_count: number;
      }>(
        `SELECT COALESCE(MAX(sort_order), 0) + 100 AS sort_order,
                COUNT(*)::integer AS provider_count
         FROM ai_providers WHERE deleted_at IS NULL`,
      );
      if ((order.rows[0]?.provider_count ?? 0) >= 100) {
        await client.query("ROLLBACK");
        return conflict("At most 100 active AI providers can be configured.");
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO ai_providers (
           id, name, api_kind, base_url, model, secret_ref, encrypted_secret, parameters,
           request_timeout_ms, enabled, sort_order
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
        [
          id,
          configuration.name,
          configuration.apiKind,
          configuration.baseUrl,
          configuration.model,
          configuration.secretRef ?? "",
          configuration.secret === undefined || configuration.secret === null
            ? null
            : this.cipher.encrypt(configuration.secret),
          JSON.stringify(configuration.parameters),
          configuration.requestTimeoutMs,
          configuration.enabled,
          order.rows[0]?.sort_order ?? 100,
        ],
      );
      await client.query(
        "INSERT INTO ai_provider_health (provider_id) VALUES ($1)",
        [id],
      );
      const provider = await this.readProvider(client, id);
      await client.query("COMMIT");
      if (provider === null) {
        throw new Error("The created AI provider could not be read.");
      }
      return { status: "ok", value: provider };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) {
        return conflict("An active AI provider already uses this name.");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateProvider(
    providerId: string,
    expectedVersion: number,
    configuration: AiProviderConfiguration,
  ): Promise<AiMutationResult<AiProviderRecord>> {
    try {
      const result = await this.pool.query<ProviderRow>(
        `UPDATE ai_providers SET
           name = $3, api_kind = $4, base_url = $5, model = $6,
           secret_ref = $7, encrypted_secret = COALESCE($11, encrypted_secret), parameters = $8::jsonb,
           request_timeout_ms = $9, enabled = $10,
           version = version + 1, updated_at = NOW()
         WHERE id = $1 AND version = $2 AND deleted_at IS NULL
        RETURNING id, name, api_kind, base_url, model, secret_ref, encrypted_secret, parameters,
                   request_timeout_ms, enabled, sort_order, version,
                   created_at, updated_at`,
        [
          providerId,
          expectedVersion,
          configuration.name,
          configuration.apiKind,
          configuration.baseUrl,
          configuration.model,
          configuration.secretRef ?? "",
          JSON.stringify(configuration.parameters),
          configuration.requestTimeoutMs,
          configuration.enabled,
          configuration.secret === undefined || configuration.secret === null
            ? null
            : this.cipher.encrypt(configuration.secret),
        ],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "ok", value: providerRecord(row, this.cipher) };
      }
      return this.providerMutationMiss(providerId);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return conflict("An active AI provider already uses this name.");
      }
      throw error;
    }
  }

  async setProviderEnabled(
    providerId: string,
    expectedVersion: number,
    enabled: boolean,
  ): Promise<AiMutationResult<AiProviderRecord>> {
    const result = await this.pool.query<ProviderRow>(
      `UPDATE ai_providers
       SET enabled = $3, version = version + 1, updated_at = NOW()
       WHERE id = $1 AND version = $2 AND deleted_at IS NULL
       RETURNING id, name, api_kind, base_url, model, secret_ref, encrypted_secret, parameters,
                 request_timeout_ms, enabled, sort_order, version,
                 created_at, updated_at`,
      [providerId, expectedVersion, enabled],
    );
    const row = result.rows[0];
    return row === undefined
      ? this.providerMutationMiss(providerId)
      : { status: "ok", value: providerRecord(row, this.cipher) };
  }

  async reorderProviders(
    providers: readonly { id: string; expectedVersion: number }[],
  ): Promise<AiMutationResult<readonly AiProviderRecord[]>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE ai_providers IN SHARE ROW EXCLUSIVE MODE");
      const current = await client.query<ProviderRow>(
        `${providerSelect} WHERE deleted_at IS NULL FOR UPDATE`,
      );
      const expected = new Map(
        providers.map((provider) => [provider.id, provider.expectedVersion]),
      );
      if (
        expected.size !== providers.length ||
        current.rows.length !== providers.length ||
        current.rows.some((row) => expected.get(row.id) !== row.version)
      ) {
        await client.query("ROLLBACK");
        return conflict("The AI provider order payload is stale.");
      }
      for (const [index, provider] of providers.entries()) {
        await client.query(
          `UPDATE ai_providers
           SET sort_order = $2, version = version + 1, updated_at = NOW()
           WHERE id = $1`,
          [provider.id, (index + 1) * 100],
        );
      }
      const reordered = await client.query<ProviderRow>(
        `${providerSelect}
         WHERE deleted_at IS NULL ORDER BY sort_order, id`,
      );
      await client.query("COMMIT");
      return {
        status: "ok",
        value: reordered.rows.map((row) => providerRecord(row, this.cipher)),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteProvider(
    providerId: string,
    expectedVersion: number,
  ): Promise<AiMutationResult<AiProviderRecord>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await this.readProvider(client, providerId, true);
      if (existing === null) {
        await client.query("ROLLBACK");
        return { status: "not-found" };
      }
      if (existing.version !== expectedVersion) {
        await client.query("ROLLBACK");
        return conflict("The AI provider version is stale.");
      }
      const referenced = await client.query(
        `SELECT 1
         FROM ai_provider_routes r
         INNER JOIN ai_provider_route_members m
           ON m.route_version_id = r.current_version_id
         WHERE r.deleted_at IS NULL AND m.provider_id = $1
         LIMIT 1`,
        [providerId],
      );
      if (referenced.rowCount !== 0) {
        await client.query("ROLLBACK");
        return conflict("The AI provider is referenced by an active route.");
      }
      const deleted = await client.query<ProviderRow>(
        `UPDATE ai_providers
         SET enabled = FALSE, deleted_at = NOW(), updated_at = NOW(),
             version = version + 1
         WHERE id = $1
         RETURNING id, name, api_kind, base_url, model, secret_ref, encrypted_secret, parameters,
                   request_timeout_ms, enabled, sort_order, version,
                   created_at, updated_at`,
        [providerId],
      );
      await client.query("COMMIT");
      const row = deleted.rows[0];
      return {
        status: "ok",
        value: row === undefined ? existing : providerRecord(row, this.cipher),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getProviderHealth(
    providerId: string,
  ): Promise<AiProviderHealth | null> {
    const result = await this.pool.query<HealthRow>(
      "SELECT * FROM ai_provider_health WHERE provider_id = $1",
      [providerId],
    );
    const row = result.rows[0];
    return row === undefined ? null : healthRecord(row);
  }

  async resetProviderHealth(
    providerId: string,
  ): Promise<AiProviderHealth | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await this.lockHealth(client, providerId);
      if (current === null) {
        await client.query("ROLLBACK");
        return null;
      }
      await this.writeHealthEvent(
        client,
        current.state,
        "healthy",
        providerId,
        "manual-reset",
        null,
      );
      const result = await client.query<HealthRow>(
        `UPDATE ai_provider_health SET
           state = 'healthy', consecutive_failures = 0,
           degraded_until = NULL, half_open_claimed_at = NULL,
           last_error_code = NULL, version = version + 1, updated_at = NOW()
         WHERE provider_id = $1 RETURNING *`,
        [providerId],
      );
      await client.query("COMMIT");
      return healthRecord(result.rows[0] ?? current);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordProviderSuccess(providerId: string): Promise<AiProviderHealth> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await this.requiredLockedHealth(client, providerId);
      await this.writeHealthEvent(
        client,
        current.state,
        "healthy",
        providerId,
        "request-succeeded",
        null,
      );
      const result = await client.query<HealthRow>(
        `UPDATE ai_provider_health SET
           state = 'healthy', consecutive_failures = 0,
           degraded_until = NULL, half_open_claimed_at = NULL,
           last_success_at = NOW(), last_error_code = NULL,
           version = version + 1, updated_at = NOW()
         WHERE provider_id = $1 RETURNING *`,
        [providerId],
      );
      await client.query("COMMIT");
      return healthRecord(result.rows[0] ?? current);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordProviderFailure(input: {
    providerId: string;
    errorCode: string;
    countsForDegrade: boolean;
    failureThreshold: number;
    cooldownMs: number;
  }): Promise<AiProviderHealth> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await this.requiredLockedHealth(client, input.providerId);
      const failures = input.countsForDegrade
        ? current.consecutive_failures + 1
        : current.consecutive_failures;
      // A half-open request is the single recovery probe. Any failed probe must
      // close the circuit again, even when the particular error category does
      // not normally contribute to the consecutive-failure threshold.
      const degrade =
        current.state === "half-open" ||
        (input.countsForDegrade && failures >= input.failureThreshold);
      const nextState: AiProviderHealthState = degrade
        ? "degraded"
        : current.state;
      if (nextState !== current.state) {
        await this.writeHealthEvent(
          client,
          current.state,
          nextState,
          input.providerId,
          current.state === "half-open"
            ? "half-open-probe-failed"
            : "failure-threshold",
          input.errorCode,
        );
      }
      const result = await client.query<HealthRow>(
        `UPDATE ai_provider_health SET
           state = $2, consecutive_failures = $3,
           degraded_until = CASE WHEN $4 THEN NOW() + ($5 * INTERVAL '1 millisecond') ELSE degraded_until END,
           half_open_claimed_at = CASE WHEN $4 THEN NULL ELSE half_open_claimed_at END,
           last_failure_at = NOW(), last_error_code = $6,
           version = version + 1, updated_at = NOW()
         WHERE provider_id = $1 RETURNING *`,
        [
          input.providerId,
          nextState,
          failures,
          degrade,
          input.cooldownMs,
          input.errorCode,
        ],
      );
      await client.query("COMMIT");
      return healthRecord(result.rows[0] ?? current);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listRoutes(): Promise<readonly AiProviderRouteRecord[]> {
    const result = await this.pool.query<RouteRow>(
      `${routeSelect}
       WHERE r.deleted_at IS NULL
       GROUP BY r.id, rv.id
       ORDER BY r.updated_at DESC, r.id`,
    );
    return result.rows.map(routeRecord);
  }

  async getRoute(routeId: string): Promise<AiProviderRouteRecord | null> {
    const result = await this.pool.query<RouteRow>(
      `${routeSelect}
       WHERE r.id = $1 AND r.deleted_at IS NULL
       GROUP BY r.id, rv.id`,
      [routeId],
    );
    const row = result.rows[0];
    return row === undefined ? null : routeRecord(row);
  }

  async createRoute(
    configuration: AiRouteConfiguration,
  ): Promise<AiMutationResult<AiProviderRouteRecord>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const providersValid = await this.validateRouteProviders(
        client,
        configuration.providerIds,
      );
      if (!providersValid) {
        await client.query("ROLLBACK");
        return conflict("The route contains a missing AI provider.");
      }
      const routeId = randomUUID();
      const versionId = randomUUID();
      await client.query(
        `INSERT INTO ai_provider_routes (id, name, enabled)
         VALUES ($1, $2, $3)`,
        [routeId, configuration.name, configuration.enabled],
      );
      await this.insertRouteVersion(
        client,
        routeId,
        versionId,
        1,
        configuration,
      );
      await client.query(
        `UPDATE ai_provider_routes SET current_version_id = $2 WHERE id = $1`,
        [routeId, versionId],
      );
      const route = await this.readRoute(client, routeId);
      await client.query("COMMIT");
      if (route === null) {
        throw new Error("The created AI provider route could not be read.");
      }
      return { status: "ok", value: route };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) {
        return conflict("An active AI provider route already uses this name.");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateRoute(
    routeId: string,
    expectedVersion: number,
    configuration: AiRouteConfiguration,
  ): Promise<AiMutationResult<AiProviderRouteRecord>> {
    return this.mutateRoute(routeId, expectedVersion, configuration);
  }

  async setRouteEnabled(
    routeId: string,
    expectedVersion: number,
    enabled: boolean,
  ): Promise<AiMutationResult<AiProviderRouteRecord>> {
    const existing = await this.getRoute(routeId);
    if (existing === null) {
      return { status: "not-found" };
    }
    return this.mutateRoute(routeId, expectedVersion, {
      name: existing.name,
      providerIds: existing.providerIds,
      fallbackEnabled: existing.fallbackEnabled,
      retryPolicy: existing.retryPolicy,
      degradePolicy: existing.degradePolicy,
      enabled,
    });
  }

  async deleteRoute(
    routeId: string,
    expectedVersion: number,
  ): Promise<AiMutationResult<AiProviderRouteRecord>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const route = await this.readRoute(client, routeId, true);
      if (route === null) {
        await client.query("ROLLBACK");
        return { status: "not-found" };
      }
      if (route.version !== expectedVersion) {
        await client.query("ROLLBACK");
        return conflict("The AI provider route version is stale.");
      }
      const workflowReference = await client.query(
        `SELECT 1
         FROM workflow_versions w
         INNER JOIN workflows workflow
           ON workflow.published_version_id = w.id
          AND workflow.status = 'active'
          AND workflow.deleted_at IS NULL
         CROSS JOIN LATERAL jsonb_array_elements(w.definition -> 'nodes') AS node
         WHERE node ->> 'type' = 'ai-chat'
           AND node -> 'config' ->> 'providerRouteId' = $1
         LIMIT 1`,
        [routeId],
      );
      if (workflowReference.rowCount !== 0) {
        await client.query("ROLLBACK");
        return conflict("The AI provider route is used by an active workflow.");
      }
      await client.query(
        `UPDATE ai_provider_routes
         SET enabled = FALSE, deleted_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [routeId],
      );
      await client.query("COMMIT");
      return { status: "ok", value: route };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getRouteSnapshot(routeId: string): Promise<AiRouteSnapshot | null> {
    const route = await this.getRoute(routeId);
    if (route === null || !route.enabled) {
      return null;
    }
    const providers =
      route.providerIds.length === 0
        ? await this.listProviders()
        : await this.providersByIds(route.providerIds);
    return {
      route,
      providers: providers.filter((provider) => provider.enabled),
    };
  }

  async selectCandidates(
    snapshot: AiRouteSnapshot,
  ): Promise<AiCandidateSelection> {
    if (snapshot.providers.length === 0) {
      return { candidates: [], nextAvailableAt: null };
    }
    const ids = snapshot.providers.map((provider) => provider.id);
    const health = await this.pool.query<HealthRow>(
      `SELECT * FROM ai_provider_health
       WHERE provider_id = ANY($1::uuid[])`,
      [ids],
    );
    const byId = new Map(health.rows.map((row) => [row.provider_id, row]));
    const now = Date.now();
    const reclaimBefore = now - 120_000;
    const activeHalfOpen = health.rows.some(
      (row) =>
        row.state === "half-open" &&
        row.half_open_claimed_at !== null &&
        row.half_open_claimed_at.getTime() > reclaimBefore,
    );
    const eligible = activeHalfOpen
      ? undefined
      : snapshot.providers.find((provider) => {
          const row = byId.get(provider.id);
          return (
            row !== undefined &&
            ((row.state === "degraded" &&
              row.degraded_until !== null &&
              row.degraded_until.getTime() <= now) ||
              (row.state === "half-open" &&
                row.half_open_claimed_at !== null &&
                row.half_open_claimed_at.getTime() <= reclaimBefore))
          );
        });
    const candidates: AiCandidate[] = snapshot.providers.flatMap((provider) => {
      const row = byId.get(provider.id);
      return row !== undefined &&
        (row.state === "healthy" || provider.id === eligible?.id)
        ? [{ provider, healthState: row.state }]
        : [];
    });
    const nextAvailable = health.rows
      .flatMap((row) => {
        if (row.state === "degraded" && row.degraded_until !== null) {
          return [row.degraded_until.getTime()];
        }
        if (row.state === "half-open" && row.half_open_claimed_at !== null) {
          return [row.half_open_claimed_at.getTime() + 120_000];
        }
        return [];
      })
      .sort((left, right) => left - right)[0];
    return {
      candidates,
      nextAvailableAt:
        nextAvailable === undefined || !Number.isFinite(nextAvailable)
          ? null
          : new Date(nextAvailable).toISOString(),
    };
  }

  async claimProviderProbe(
    providerId: string,
    candidateProviderIds: readonly string[],
  ): Promise<AiProviderHealth | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const health = await client.query<HealthRow>(
        `SELECT * FROM ai_provider_health
         WHERE provider_id = ANY($1::uuid[])
         ORDER BY provider_id FOR UPDATE`,
        [candidateProviderIds],
      );
      const now = Date.now();
      const reclaimBefore = now - 120_000;
      const activeHalfOpen = health.rows.some(
        (row) =>
          row.state === "half-open" &&
          row.half_open_claimed_at !== null &&
          row.half_open_claimed_at.getTime() > reclaimBefore,
      );
      const current = health.rows.find((row) => row.provider_id === providerId);
      const eligible =
        !activeHalfOpen &&
        current !== undefined &&
        ((current.state === "degraded" &&
          current.degraded_until !== null &&
          current.degraded_until.getTime() <= now) ||
          (current.state === "half-open" &&
            current.half_open_claimed_at !== null &&
            current.half_open_claimed_at.getTime() <= reclaimBefore));
      if (!eligible || current === undefined) {
        await client.query("ROLLBACK");
        return null;
      }
      await this.writeHealthEvent(
        client,
        current.state,
        "half-open",
        providerId,
        "cooldown-probe",
        current.last_error_code,
      );
      const updated = await client.query<HealthRow>(
        `UPDATE ai_provider_health SET
           state = 'half-open', half_open_claimed_at = NOW(),
           version = version + 1, updated_at = NOW()
         WHERE provider_id = $1 RETURNING *`,
        [providerId],
      );
      await client.query("COMMIT");
      const row = updated.rows[0];
      return row === undefined ? null : healthRecord(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordAttempt(input: AiAttemptRecordInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO ai_provider_attempts (
         id, execution_id, node_id, route_id, route_version, provider_id,
         provider_name, provider_version, model, round, sequence, status,
         health_state,
         selection_health_state, duration_ms, error_category, error_code,
         retryable, fallback_allowed, client_request_id, provider_request_id,
         http_status, request_hash, request_message_count, request_characters,
         response_bytes, response_body_hash, response_finish_reason,
         response_content_characters, response_reasoning_characters,
         prompt_tokens, completion_tokens, reasoning_tokens, total_tokens,
         cached_prompt_tokens, cache_write_prompt_tokens,
         cache_miss_prompt_tokens
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
         $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34,
         $35, $36, $37
       )`,
      [
        randomUUID(),
        input.executionId,
        input.nodeId,
        input.routeId,
        input.routeVersion,
        input.providerId,
        input.providerName,
        input.providerVersion,
        input.model,
        input.round,
        input.sequence,
        input.status,
        input.healthState,
        input.selectionHealthState,
        input.durationMs,
        input.errorCategory,
        input.errorCode,
        input.retryable,
        input.fallbackAllowed,
        input.diagnostics?.clientRequestId ?? null,
        input.diagnostics?.providerRequestId ?? null,
        input.diagnostics?.httpStatus ?? null,
        input.diagnostics?.requestHash ?? null,
        input.diagnostics?.requestMessageCount ?? null,
        input.diagnostics?.requestCharacters ?? null,
        input.diagnostics?.responseBytes ?? null,
        input.diagnostics?.responseBodyHash ?? null,
        input.diagnostics?.responseFinishReason ?? null,
        input.diagnostics?.responseContentCharacters ?? null,
        input.diagnostics?.responseReasoningCharacters ?? null,
        input.diagnostics?.promptTokens ?? null,
        input.diagnostics?.completionTokens ?? null,
        input.diagnostics?.reasoningTokens ?? null,
        input.diagnostics?.totalTokens ?? null,
        input.diagnostics?.cachedPromptTokens ?? null,
        input.diagnostics?.cacheWritePromptTokens ?? null,
        input.diagnostics?.cacheMissPromptTokens ?? null,
      ],
    );
  }

  async listAttempts(
    executionId: string,
    nodeId?: string,
  ): Promise<readonly AiProviderAttemptView[]> {
    const result = await this.pool.query<AttemptRow>(
      `SELECT * FROM ai_provider_attempts
       WHERE execution_id = $1 AND ($2::text IS NULL OR node_id = $2)
       ORDER BY round, sequence`,
      [executionId, nodeId ?? null],
    );
    return result.rows.map(attemptView);
  }

  async isReady(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ ready: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM schema_migrations WHERE name = '0016_ai_attempt_diagnostics.sql'
         ) AS ready`,
      );
      return result.rows[0]?.ready === true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async providerMutationMiss(
    providerId: string,
  ): Promise<AiMutationResult<AiProviderRecord>> {
    return (await this.getProvider(providerId)) === null
      ? { status: "not-found" }
      : conflict("The AI provider version is stale.");
  }

  private async readProvider(
    client: PoolClient,
    providerId: string,
    lock = false,
  ): Promise<AiProviderRecord | null> {
    const result = await client.query<ProviderRow>(
      `${providerSelect}
       WHERE id = $1 AND deleted_at IS NULL${lock ? " FOR UPDATE" : ""}`,
      [providerId],
    );
    const row = result.rows[0];
    return row === undefined ? null : providerRecord(row, this.cipher);
  }

  private async providersByIds(
    providerIds: readonly string[],
  ): Promise<readonly AiProviderRecord[]> {
    const result = await this.pool.query<ProviderRow>(
      `${providerSelect}
       WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [providerIds],
    );
    const byId = new Map(
      result.rows.map((row) => [row.id, providerRecord(row, this.cipher)]),
    );
    return providerIds.flatMap((id) => {
      const provider = byId.get(id);
      return provider === undefined ? [] : [provider];
    });
  }

  private async lockHealth(
    client: PoolClient,
    providerId: string,
  ): Promise<HealthRow | null> {
    const result = await client.query<HealthRow>(
      "SELECT * FROM ai_provider_health WHERE provider_id = $1 FOR UPDATE",
      [providerId],
    );
    return result.rows[0] ?? null;
  }

  private async requiredLockedHealth(
    client: PoolClient,
    providerId: string,
  ): Promise<HealthRow> {
    const health = await this.lockHealth(client, providerId);
    if (health === null) {
      throw new Error(`AI provider health '${providerId}' does not exist.`);
    }
    return health;
  }

  private async writeHealthEvent(
    client: PoolClient,
    fromState: AiProviderHealthState,
    toState: AiProviderHealthState,
    providerId: string,
    reason: string,
    errorCode: string | null,
  ): Promise<void> {
    if (fromState === toState) {
      return;
    }
    await client.query(
      `INSERT INTO ai_provider_health_events (
         id, provider_id, from_state, to_state, reason, error_code
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), providerId, fromState, toState, reason, errorCode],
    );
  }

  private async validateRouteProviders(
    client: PoolClient,
    providerIds: readonly string[],
  ): Promise<boolean> {
    if (new Set(providerIds).size !== providerIds.length) {
      return false;
    }
    if (providerIds.length === 0) {
      return true;
    }
    const result = await client.query<{ id: string }>(
      `SELECT id FROM ai_providers
       WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
       FOR SHARE`,
      [providerIds],
    );
    return result.rows.length === providerIds.length;
  }

  private async insertRouteVersion(
    client: PoolClient,
    routeId: string,
    versionId: string,
    version: number,
    configuration: AiRouteConfiguration,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ai_provider_route_versions (
         id, route_id, version, fallback_enabled, retry_policy, degrade_policy
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [
        versionId,
        routeId,
        version,
        configuration.fallbackEnabled,
        JSON.stringify(configuration.retryPolicy),
        JSON.stringify(configuration.degradePolicy),
      ],
    );
    for (const [index, providerId] of configuration.providerIds.entries()) {
      await client.query(
        `INSERT INTO ai_provider_route_members (
           route_version_id, provider_id, position
         ) VALUES ($1, $2, $3)`,
        [versionId, providerId, index + 1],
      );
    }
  }

  private async mutateRoute(
    routeId: string,
    expectedVersion: number,
    configuration: AiRouteConfiguration,
  ): Promise<AiMutationResult<AiProviderRouteRecord>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await this.readRoute(client, routeId, true);
      if (existing === null) {
        await client.query("ROLLBACK");
        return { status: "not-found" };
      }
      if (existing.version !== expectedVersion) {
        await client.query("ROLLBACK");
        return conflict("The AI provider route version is stale.");
      }
      if (
        !(await this.validateRouteProviders(client, configuration.providerIds))
      ) {
        await client.query("ROLLBACK");
        return conflict("The route contains a missing AI provider.");
      }
      const nextVersion = existing.version + 1;
      const versionId = existing.versionId;
      await client.query(
        `UPDATE ai_provider_route_versions
         SET version = $2,
             fallback_enabled = $3,
             retry_policy = $4::jsonb,
             degrade_policy = $5::jsonb
         WHERE id = $1`,
        [
          versionId,
          nextVersion,
          configuration.fallbackEnabled,
          JSON.stringify(configuration.retryPolicy),
          JSON.stringify(configuration.degradePolicy),
        ],
      );
      await client.query(
        "DELETE FROM ai_provider_route_members WHERE route_version_id = $1",
        [versionId],
      );
      for (const [index, providerId] of configuration.providerIds.entries()) {
        await client.query(
          `INSERT INTO ai_provider_route_members (
             route_version_id, provider_id, position
           ) VALUES ($1, $2, $3)`,
          [versionId, providerId, index + 1],
        );
      }
      await client.query(
        `UPDATE ai_provider_routes
         SET name = $2, enabled = $3, updated_at = NOW()
         WHERE id = $1`,
        [routeId, configuration.name, configuration.enabled],
      );
      const updated = await this.readRoute(client, routeId);
      await client.query("COMMIT");
      if (updated === null) {
        throw new Error("The updated AI provider route could not be read.");
      }
      return { status: "ok", value: updated };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) {
        return conflict("An active AI provider route already uses this name.");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async readRoute(
    client: PoolClient,
    routeId: string,
    lock = false,
  ): Promise<AiProviderRouteRecord | null> {
    if (lock) {
      await client.query(
        `SELECT id FROM ai_provider_routes
         WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [routeId],
      );
    }
    const result = await client.query<RouteRow>(
      `${routeSelect}
       WHERE r.id = $1 AND r.deleted_at IS NULL
       GROUP BY r.id, rv.id`,
      [routeId],
    );
    const row = result.rows[0];
    return row === undefined ? null : routeRecord(row);
  }
}
