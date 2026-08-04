import { sha256 } from "../../app/canonical-json.js";
import type { AiRepository } from "./ai-repository.js";
import type {
  AiCallFailure,
  AiCallResult,
  AiProviderHealth,
  AiRouteRequest,
  AiRouteResult,
  AiRouteSnapshot,
} from "./ai-types.js";
import type { AiClient } from "./openai-compatible-client.js";
import {
  isProviderSecretConfigured,
  resolveProviderSecret,
  type SecretResolver,
} from "./secret-resolver.js";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function outputFailure(
  code: string,
  summary: string,
  fallbackAllowed: boolean,
  durationMs: number,
): AiCallFailure {
  return {
    status: "failed",
    category: fallbackAllowed ? "invalid-response" : "content-safety",
    code,
    summary,
    retryable: false,
    fallbackAllowed,
    countsForDegrade: false,
    durationMs,
  };
}

function validateOutput(
  text: string,
  request: AiRouteRequest,
  snapshot: AiRouteSnapshot,
  secrets: SecretResolver,
  durationMs: number,
): AiCallFailure | null {
  if (text.length > request.maxOutputCharacters) {
    return outputFailure(
      "AI_OUTPUT_TOO_LONG",
      "The AI output exceeds the configured character limit.",
      true,
      durationMs,
    );
  }
  if (/\p{Cc}/u.test(text.replace(/[\n\r\t]/gu, ""))) {
    return outputFailure(
      "AI_OUTPUT_CONTROL_CHARACTERS",
      "The AI output contains disallowed control characters.",
      false,
      durationMs,
    );
  }
  if (request.outputFormat === "json") {
    try {
      JSON.parse(text);
    } catch {
      return outputFailure(
        "AI_OUTPUT_INVALID_JSON",
        "The AI output is not valid JSON.",
        true,
        durationMs,
      );
    }
  }
  if (
    request.protectedPrompt !== null &&
    request.protectedPrompt.length >= 20 &&
    text.includes(request.protectedPrompt)
  ) {
    return outputFailure(
      "AI_OUTPUT_PROMPT_DISCLOSURE",
      "The AI output reproduced protected prompt content.",
      false,
      durationMs,
    );
  }
  for (const provider of snapshot.providers) {
    const secret = resolveProviderSecret(provider, secrets);
    if (secret !== null && secret.length >= 8 && text.includes(secret)) {
      return outputFailure(
        "AI_OUTPUT_SECRET_DISCLOSURE",
        "The AI output contains a configured server secret.",
        false,
        durationMs,
      );
    }
  }
  return null;
}

export class AiRoutingService {
  constructor(
    private readonly repository: AiRepository,
    private readonly client: AiClient,
    private readonly secrets: SecretResolver,
  ) {}

  async execute(request: AiRouteRequest): Promise<AiRouteResult> {
    const storedSnapshot = await this.repository.getRouteSnapshot(
      request.routeId,
    );
    const snapshot =
      storedSnapshot === null
        ? null
        : {
            ...storedSnapshot,
            providers: storedSnapshot.providers.filter((provider) =>
              isProviderSecretConfigured(provider, this.secrets),
            ),
          };
    if (snapshot === null || snapshot.providers.length === 0) {
      return {
        status: "failed",
        code: "AI_ROUTE_UNAVAILABLE",
        summary:
          "The AI provider route is disabled or has no enabled candidates with configured credentials.",
        retryable: false,
        attemptCount: 0,
      };
    }

    const startedAt = Date.now();
    const deadline = startedAt + request.timeoutMs;
    let attemptCount = 0;
    let lastFailure: AiCallFailure | null = null;
    let probeBusy = false;
    let retryableProviderIds: Set<string> | null = null;
    const candidateProviderIds = snapshot.providers.map(
      (provider) => provider.id,
    );

    for (
      let round = 1;
      round <= snapshot.route.retryPolicy.maxRounds;
      round += 1
    ) {
      const selection = await this.repository.selectCandidates(snapshot);
      const candidates = selection.candidates.filter(
        (candidate) =>
          retryableProviderIds === null ||
          retryableProviderIds.has(candidate.provider.id),
      );
      if (candidates.length === 0) {
        const availableAt =
          selection.nextAvailableAt === null
            ? null
            : Date.parse(selection.nextAvailableAt);
        if (
          availableAt !== null &&
          availableAt < deadline &&
          round < snapshot.route.retryPolicy.maxRounds
        ) {
          await delay(Math.max(0, availableAt - Date.now()));
          continue;
        }
        return {
          status: "failed",
          code: "AI_ROUTE_DEGRADED",
          summary:
            "No AI provider candidate is currently healthy or ready to probe.",
          retryable: availableAt !== null,
          attemptCount,
        };
      }

      const nextRoundProviderIds = new Set<string>();
      let sequence = 0;
      for (const candidate of candidates) {
        if (Date.now() >= deadline) {
          return {
            status: "failed",
            code: "AI_NODE_TIMEOUT",
            summary: "The AI node exhausted its total time budget.",
            retryable: true,
            attemptCount,
          };
        }
        let selectionHealthState = candidate.healthState;
        if (candidate.healthState !== "healthy") {
          const claimed = await this.repository.claimProviderProbe(
            candidate.provider.id,
            candidateProviderIds,
          );
          if (claimed === null) {
            probeBusy = true;
            nextRoundProviderIds.add(candidate.provider.id);
            if (!snapshot.route.fallbackEnabled) {
              break;
            }
            continue;
          }
          selectionHealthState = claimed.state;
        }
        sequence += 1;
        attemptCount += 1;
        let result: AiCallResult = await this.client.call(candidate.provider, {
          messages: request.messages,
          maxOutputTokens: request.maxOutputTokens,
          temperature: request.temperature,
          timeoutMs: Math.max(1, deadline - Date.now()),
        });

        if (result.status === "succeeded") {
          const policyFailure = validateOutput(
            result.text,
            request,
            snapshot,
            this.secrets,
            result.durationMs,
          );
          if (policyFailure !== null) {
            result = policyFailure;
          }
        }

        let health: AiProviderHealth;
        if (result.status === "succeeded") {
          health = await this.repository.recordProviderSuccess(
            candidate.provider.id,
          );
          await this.repository.recordAttempt({
            executionId: request.executionId,
            nodeId: request.nodeId,
            routeId: snapshot.route.id,
            routeVersion: snapshot.route.version,
            providerId: candidate.provider.id,
            providerName: candidate.provider.name,
            providerVersion: candidate.provider.version,
            model: candidate.provider.model,
            round,
            sequence,
            status: "succeeded",
            selectionHealthState,
            healthState: health.state,
            durationMs: result.durationMs,
            errorCategory: null,
            errorCode: null,
            retryable: null,
            fallbackAllowed: null,
          });
          return {
            status: "succeeded",
            text: result.text,
            providerId: candidate.provider.id,
            providerName: candidate.provider.name,
            providerVersion: candidate.provider.version,
            model: candidate.provider.model,
            routeVersion: snapshot.route.version,
            round,
            attemptCount,
            durationMs: Math.max(0, Date.now() - startedAt),
          };
        }

        health = await this.repository.recordProviderFailure({
          providerId: candidate.provider.id,
          errorCode: result.code,
          countsForDegrade: result.countsForDegrade,
          failureThreshold: snapshot.route.degradePolicy.failureThreshold,
          cooldownMs: snapshot.route.degradePolicy.cooldownMs,
        });
        await this.repository.recordAttempt({
          executionId: request.executionId,
          nodeId: request.nodeId,
          routeId: snapshot.route.id,
          routeVersion: snapshot.route.version,
          providerId: candidate.provider.id,
          providerName: candidate.provider.name,
          providerVersion: candidate.provider.version,
          model: candidate.provider.model,
          round,
          sequence,
          status: "failed",
          selectionHealthState,
          healthState: health.state,
          durationMs: result.durationMs,
          errorCategory: result.category,
          errorCode: result.code,
          retryable: result.retryable,
          fallbackAllowed: result.fallbackAllowed,
        });
        lastFailure = result;
        if (result.retryable) {
          nextRoundProviderIds.add(candidate.provider.id);
        }
        if (!snapshot.route.fallbackEnabled || !result.fallbackAllowed) {
          return {
            status: "failed",
            code: result.code,
            summary: result.summary,
            retryable: result.retryable,
            attemptCount,
          };
        }
      }

      if (
        nextRoundProviderIds.size === 0 ||
        round >= snapshot.route.retryPolicy.maxRounds
      ) {
        break;
      }
      retryableProviderIds = nextRoundProviderIds;
      const waitMs =
        snapshot.route.retryPolicy.initialDelayMs * 2 ** (round - 1);
      if (Date.now() + waitMs >= deadline) {
        break;
      }
      await delay(waitMs);
    }

    return {
      status: "failed",
      code:
        lastFailure?.code ??
        (probeBusy ? "AI_ROUTE_PROBE_BUSY" : "AI_ROUTE_EXHAUSTED"),
      summary:
        lastFailure?.summary ??
        (probeBusy
          ? "The AI provider recovery probe is already claimed."
          : "All AI provider candidates were exhausted."),
      retryable: lastFailure?.retryable ?? probeBusy,
      attemptCount,
    };
  }

  outputSummary(result: Extract<AiRouteResult, { status: "succeeded" }>) {
    return {
      providerId: result.providerId,
      providerVersion: result.providerVersion,
      model: result.model,
      routeVersion: result.routeVersion,
      round: result.round,
      attemptCount: result.attemptCount,
      durationMs: result.durationMs,
      outputCharacters: result.text.length,
      outputHash: sha256(result.text),
    };
  }
}
