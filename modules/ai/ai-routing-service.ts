import { randomUUID } from "node:crypto";

import { sha256 } from "../../app/canonical-json.js";
import type { AiRepository } from "./ai-repository.js";
import type {
  AiCallFailure,
  AiCallResult,
  AiChatMessage,
  AiContentPart,
  AiRouteCandidateDecision,
  AiProviderHealth,
  AiRouteRequest,
  AiRouteResult,
  AiRouteSnapshot,
  AiRouteTracePhase,
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
  // Conversation summaries are protected derivatives of the archived chat.
  // A participant may legitimately paste text that is identical to a
  // configured Provider secret, and reproducing it in the summary must not
  // permanently block the chat's compression cursor. User-facing workflow
  // replies and image summaries retain the disclosure guard.
  if (request.purpose !== "context-summary") {
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
  }
  return null;
}

function supportsHostedSearch(provider: AiRouteSnapshot["providers"][number]) {
  return (
    provider.apiKind === "responses" &&
    provider.capabilities?.hostedWebSearch === true &&
    provider.capabilityProbe?.hostedWebSearch === "verified"
  );
}

function supportsLocalTools(provider: AiRouteSnapshot["providers"][number]) {
  return (
    provider.capabilities?.functionCalling === true &&
    provider.capabilityProbe?.functionCalling === "verified"
  );
}

function requestHasImages(request: AiRouteRequest): boolean {
  return request.messages.some(
    (message) =>
      typeof message.content !== "string" &&
      message.content.some((part: AiContentPart) => part.type === "image"),
  );
}

function withoutImages(messages: readonly AiChatMessage[]): AiChatMessage[] {
  const stripped = messages.map((message) => ({
    ...message,
    content:
      typeof message.content !== "string"
        ? message.content.filter((part) => part.type !== "image")
        : message.content,
  }));
  const warning: AiChatMessage = {
    role: "system",
    content:
      "BubblePilot could not provide the referenced images to an available provider. Do not claim to have seen or analyzed them; answer only from the remaining text and clearly state the limitation when it matters.",
  };
  const firstNonSystem = stripped.findIndex(
    (message) => message.role !== "system",
  );
  return firstNonSystem < 0
    ? [...stripped, warning]
    : [
        ...stripped.slice(0, firstNonSystem),
        warning,
        ...stripped.slice(firstNonSystem),
      ];
}

function mayDegradeImages(result: AiRouteResult): boolean {
  return (
    result.status === "failed" &&
    ![
      "AI_CONTENT_SAFETY_REJECTED",
      "AI_OUTPUT_PROMPT_DISCLOSURE",
      "AI_OUTPUT_SECRET_DISCLOSURE",
    ].includes(result.code)
  );
}

export class AiRoutingService {
  constructor(
    private readonly repository: AiRepository,
    private readonly client: AiClient,
    private readonly secrets: SecretResolver,
    private readonly enableWebSearch = true,
  ) {}

  async execute(request: AiRouteRequest): Promise<AiRouteResult> {
    const withImages = requestHasImages(request);
    const result = await this.executeOnce(
      request,
      withImages ? "image-original" : "standard",
    );
    if (
      !withImages ||
      request.allowImageDegrade === false ||
      !mayDegradeImages(result)
    )
      return result;
    const degraded = await this.executeOnce(
      {
        ...request,
        messages: withoutImages(request.messages),
      },
      "image-degraded",
    );
    return {
      ...degraded,
      attemptCount: result.attemptCount + degraded.attemptCount,
    };
  }

  private async executeOnce(
    request: AiRouteRequest,
    phase: AiRouteTracePhase,
  ): Promise<AiRouteResult> {
    const traceId = randomUUID();
    const traceStartedAt = Date.now();
    const purpose = request.purpose ?? "workflow-reply";
    const agentTurn = request.agentTurn ?? 1;
    const hasImages = requestHasImages(request);
    const candidateDecisions: AiRouteCandidateDecision[] = [];
    let routeName: string | null = null;
    let routeVersion: number | null = null;
    let fallbackEnabled: boolean | null = null;
    let maxRounds: number | null = null;
    const complete = async (result: AiRouteResult): Promise<AiRouteResult> => {
      await this.repository.recordRouteTrace({
        id: traceId,
        executionId: request.executionId,
        backgroundOperationId: request.backgroundOperationId ?? null,
        purpose,
        nodeId: request.nodeId,
        routeId: request.routeId,
        routeName,
        routeVersion,
        agentTurn,
        phase,
        requestRequirements: {
          hasImages,
          allowImageDegrade: request.allowImageDegrade !== false,
          requiresTools: (request.tools?.length ?? 0) > 0,
          webSearch: request.webSearch ?? null,
        },
        fallbackEnabled,
        maxRounds,
        candidateDecisions,
        terminalStatus: result.status,
        terminalCode: result.status === "failed" ? result.code : null,
        durationMs: Math.max(0, Date.now() - traceStartedAt),
      });
      return result;
    };
    const [route, allProviders] = await Promise.all([
      this.repository.getRoute(request.routeId),
      this.repository.listProviders(),
    ]);
    routeName = route?.name ?? null;
    routeVersion = route?.version ?? null;
    fallbackEnabled = route?.fallbackEnabled ?? null;
    maxRounds = route?.retryPolicy.maxRounds ?? null;
    const providersById = new Map(
      allProviders.map((provider) => [provider.id, provider]),
    );
    const configuredProviderIds =
      route === null
        ? []
        : route.providerIds.length === 0
          ? allProviders.map((provider) => provider.id)
          : route.providerIds;
    const eligibleProviders = configuredProviderIds.flatMap(
      (providerId, configuredPosition) => {
        const provider = providersById.get(providerId);
        let reason: AiRouteCandidateDecision["reason"] = "eligible";
        if (provider === undefined) reason = "provider-unavailable";
        else if (!provider.enabled) reason = "provider-disabled";
        else if (!isProviderSecretConfigured(provider, this.secrets))
          reason = "secret-missing";
        else if (hasImages && provider.capabilities?.imageInput !== true)
          reason = "image-capability-disabled";
        else if (
          hasImages &&
          provider.capabilityProbe?.imageInput !== "verified"
        )
          reason = "image-capability-unverified";
        else if (
          request.webSearch !== undefined &&
          request.webSearch !== "disabled" &&
          !supportsHostedSearch(provider) &&
          !((request.tools?.length ?? 0) > 0 && supportsLocalTools(provider))
        )
          reason = "web-search-unsupported";
        candidateDecisions.push({
          providerId,
          providerName: provider?.name ?? null,
          providerVersion: provider?.version ?? null,
          model: provider?.model ?? null,
          configuredPosition: configuredPosition + 1,
          round: null,
          sequence: null,
          decision: reason === "eligible" ? "eligible" : "excluded",
          reason,
          healthState: null,
          imageInputConfigured: provider?.capabilities?.imageInput ?? null,
          imageInputProbe: provider?.capabilityProbe?.imageInput ?? null,
        });
        return provider !== undefined && reason === "eligible"
          ? [provider]
          : [];
      },
    );
    const snapshot: AiRouteSnapshot | null =
      route === null || !route.enabled
        ? null
        : { route, providers: eligibleProviders };
    if (
      request.webSearch !== undefined &&
      request.webSearch !== "disabled" &&
      !this.enableWebSearch
    ) {
      return complete({
        status: "failed",
        code: "AI_WEB_SEARCH_DISABLED",
        summary: "Web search is disabled for this BubblePilot instance.",
        retryable: false,
        attemptCount: 0,
      });
    }
    if (snapshot === null || snapshot.providers.length === 0) {
      return complete({
        status: "failed",
        code: "AI_ROUTE_UNAVAILABLE",
        summary:
          "The AI provider route is disabled or has no enabled candidates with configured credentials.",
        retryable: false,
        attemptCount: 0,
      });
    }

    const startedAt = Date.now();
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
      for (const unavailable of selection.unavailable) {
        const provider = unavailable.candidate.provider;
        candidateDecisions.push({
          providerId: provider.id,
          providerName: provider.name,
          providerVersion: provider.version,
          model: provider.model,
          configuredPosition: configuredProviderIds.indexOf(provider.id) + 1,
          round,
          sequence: null,
          decision: "skipped",
          reason: unavailable.reason,
          healthState: unavailable.candidate.healthState,
          imageInputConfigured: provider.capabilities?.imageInput ?? null,
          imageInputProbe: provider.capabilityProbe?.imageInput ?? null,
        });
      }
      const candidates = selection.candidates
        .filter((candidate) => {
          const retryEligible =
            retryableProviderIds === null ||
            retryableProviderIds.has(candidate.provider.id);
          if (!retryEligible) {
            candidateDecisions.push({
              providerId: candidate.provider.id,
              providerName: candidate.provider.name,
              providerVersion: candidate.provider.version,
              model: candidate.provider.model,
              configuredPosition:
                configuredProviderIds.indexOf(candidate.provider.id) + 1,
              round,
              sequence: null,
              decision: "skipped",
              reason: "retry-not-eligible",
              healthState: candidate.healthState,
              imageInputConfigured:
                candidate.provider.capabilities?.imageInput ?? null,
              imageInputProbe:
                candidate.provider.capabilityProbe?.imageInput ?? null,
            });
          }
          return retryEligible;
        })
        .sort((left, right) => {
          if (request.preferredProviderId === undefined) return 0;
          if (left.provider.id === request.preferredProviderId) return -1;
          if (right.provider.id === request.preferredProviderId) return 1;
          return 0;
        });
      if (candidates.length === 0) {
        const availableAt =
          selection.nextAvailableAt === null
            ? null
            : Date.parse(selection.nextAvailableAt);
        return complete({
          status: "failed",
          code: "AI_ROUTE_DEGRADED",
          summary:
            "No AI provider candidate is currently healthy or ready to probe.",
          retryable: availableAt !== null,
          attemptCount,
        });
      }

      const nextRoundProviderIds = new Set<string>();
      let sequence = 0;
      for (const [candidateIndex, candidate] of candidates.entries()) {
        let selectionHealthState = candidate.healthState;
        if (candidate.healthState !== "healthy") {
          const claimed = await this.repository.claimProviderProbe(
            candidate.provider.id,
            candidateProviderIds,
          );
          if (claimed === null) {
            probeBusy = true;
            nextRoundProviderIds.add(candidate.provider.id);
            candidateDecisions.push({
              providerId: candidate.provider.id,
              providerName: candidate.provider.name,
              providerVersion: candidate.provider.version,
              model: candidate.provider.model,
              configuredPosition:
                configuredProviderIds.indexOf(candidate.provider.id) + 1,
              round,
              sequence: null,
              decision: "skipped",
              reason: "probe-busy",
              healthState: candidate.healthState,
              imageInputConfigured:
                candidate.provider.capabilities?.imageInput ?? null,
              imageInputProbe:
                candidate.provider.capabilityProbe?.imageInput ?? null,
            });
            if (!snapshot.route.fallbackEnabled) {
              break;
            }
            continue;
          }
          selectionHealthState = claimed.state;
        }
        sequence += 1;
        attemptCount += 1;
        candidateDecisions.push({
          providerId: candidate.provider.id,
          providerName: candidate.provider.name,
          providerVersion: candidate.provider.version,
          model: candidate.provider.model,
          configuredPosition:
            configuredProviderIds.indexOf(candidate.provider.id) + 1,
          round,
          sequence,
          decision: "attempted",
          reason: "attempted",
          healthState: selectionHealthState,
          imageInputConfigured:
            candidate.provider.capabilities?.imageInput ?? null,
          imageInputProbe:
            candidate.provider.capabilityProbe?.imageInput ?? null,
        });
        const useHostedSearch =
          request.webSearch !== undefined &&
          request.webSearch !== "disabled" &&
          supportsHostedSearch(candidate.provider);
        let result: AiCallResult = await this.client.call(candidate.provider, {
          messages: request.messages,
          maxOutputTokens: request.maxOutputTokens,
          temperature: request.temperature,
          ...(request.executionId === null
            ? {}
            : { executionId: request.executionId }),
          clientRequestId: `${request.executionId ?? request.backgroundOperationId ?? "background"}:${request.nodeId}:${request.agentTurn ?? 1}:${round}:${sequence}`,
          ...(candidate.provider.sessionAffinity === "session-id-header" &&
          request.sessionAffinityKey !== undefined
            ? {
                sessionId: `bp_${sha256(
                  `${candidate.provider.id}\u0000${request.sessionAffinityKey}`,
                ).slice("sha256:".length)}`,
              }
            : {}),
          ...(request.promptTraceKey === undefined
            ? {}
            : {
                promptTraceKey: `${request.promptTraceKey}:${request.agentTurn ?? 1}`,
              }),
          ...(useHostedSearch ? { webSearch: request.webSearch } : {}),
          ...(!useHostedSearch && request.tools !== undefined
            ? {
                tools: request.tools,
                toolChoice: request.toolChoice ?? "auto",
              }
            : {}),
        });

        if (
          result.status === "succeeded" &&
          (result.toolCalls?.length ?? 0) === 0
        ) {
          const policyFailure = validateOutput(
            result.text,
            request,
            snapshot,
            this.secrets,
            result.durationMs,
          );
          if (policyFailure !== null) {
            result = {
              ...policyFailure,
              ...(result.diagnostics === undefined
                ? {}
                : { diagnostics: result.diagnostics }),
            };
          }
        }

        let health: AiProviderHealth;
        if (result.status === "succeeded") {
          health = await this.repository.recordProviderSuccess(
            candidate.provider.id,
          );
          await this.repository.recordAttempt({
            executionId: request.executionId,
            purpose: request.purpose ?? "workflow-reply",
            backgroundOperationId: request.backgroundOperationId ?? null,
            routeTraceId: traceId,
            routePhase: phase,
            nodeId: request.nodeId,
            routeId: snapshot.route.id,
            routeVersion: snapshot.route.version,
            providerId: candidate.provider.id,
            providerName: candidate.provider.name,
            providerVersion: candidate.provider.version,
            model: candidate.provider.model,
            agentTurn: request.agentTurn ?? 1,
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
            diagnostics: result.diagnostics ?? null,
          });
          return complete({
            status: "succeeded",
            text: result.text,
            toolCalls: result.toolCalls ?? [],
            providerId: candidate.provider.id,
            providerName: candidate.provider.name,
            providerVersion: candidate.provider.version,
            model: candidate.provider.model,
            routeVersion: snapshot.route.version,
            round,
            attemptCount,
            durationMs: Math.max(0, Date.now() - startedAt),
            diagnostics: result.diagnostics ?? null,
          });
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
          purpose: request.purpose ?? "workflow-reply",
          backgroundOperationId: request.backgroundOperationId ?? null,
          routeTraceId: traceId,
          routePhase: phase,
          nodeId: request.nodeId,
          routeId: snapshot.route.id,
          routeVersion: snapshot.route.version,
          providerId: candidate.provider.id,
          providerName: candidate.provider.name,
          providerVersion: candidate.provider.version,
          model: candidate.provider.model,
          agentTurn: request.agentTurn ?? 1,
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
          diagnostics: result.diagnostics ?? null,
        });
        lastFailure = result;
        if (result.retryable) {
          nextRoundProviderIds.add(candidate.provider.id);
        }
        // Fallback controls switching to another configured provider. It must
        // not disable the route's bounded retry rounds for a retryable failure
        // when the current provider is the only candidate (or fallback is off).
        if (!snapshot.route.fallbackEnabled || !result.fallbackAllowed) {
          for (const skipped of candidates.slice(candidateIndex + 1)) {
            candidateDecisions.push({
              providerId: skipped.provider.id,
              providerName: skipped.provider.name,
              providerVersion: skipped.provider.version,
              model: skipped.provider.model,
              configuredPosition:
                configuredProviderIds.indexOf(skipped.provider.id) + 1,
              round,
              sequence: null,
              decision: "skipped",
              reason: "fallback-stopped",
              healthState: skipped.healthState,
              imageInputConfigured:
                skipped.provider.capabilities?.imageInput ?? null,
              imageInputProbe:
                skipped.provider.capabilityProbe?.imageInput ?? null,
            });
          }
        }
        if (!result.fallbackAllowed) {
          return complete({
            status: "failed",
            code: result.code,
            summary: result.summary,
            retryable: result.retryable,
            attemptCount,
          });
        }
        if (!snapshot.route.fallbackEnabled) break;
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
      await delay(waitMs);
    }

    return complete({
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
    });
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
      tokenUsage:
        result.diagnostics === null
          ? null
          : {
              promptTokens: result.diagnostics.promptTokens,
              completionTokens: result.diagnostics.completionTokens,
              reasoningTokens: result.diagnostics.reasoningTokens,
              totalTokens: result.diagnostics.totalTokens,
              cachedPromptTokens: result.diagnostics.cachedPromptTokens,
              cacheWritePromptTokens: result.diagnostics.cacheWritePromptTokens,
              cacheMissPromptTokens: result.diagnostics.cacheMissPromptTokens,
            },
    };
  }
}
