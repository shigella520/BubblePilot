import { sha256 } from "../../app/canonical-json.js";
import type { AiRepository } from "./ai-repository.js";
import type {
  AiCallFailure,
  AiCallResult,
  AiChatMessage,
  AiContentPart,
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

function supportsImageInput(provider: AiRouteSnapshot["providers"][number]) {
  return (
    provider.capabilities?.imageInput === true &&
    provider.capabilityProbe?.imageInput === "verified"
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
    const result = await this.executeOnce(request);
    if (!withImages || !mayDegradeImages(result)) return result;
    const degraded = await this.executeOnce({
      ...request,
      messages: withoutImages(request.messages),
    });
    return {
      ...degraded,
      attemptCount: result.attemptCount + degraded.attemptCount,
    };
  }

  private async executeOnce(request: AiRouteRequest): Promise<AiRouteResult> {
    if (
      request.webSearch !== undefined &&
      request.webSearch !== "disabled" &&
      !this.enableWebSearch
    ) {
      return {
        status: "failed",
        code: "AI_WEB_SEARCH_DISABLED",
        summary: "Web search is disabled for this BubblePilot instance.",
        retryable: false,
        attemptCount: 0,
      };
    }
    const storedSnapshot = await this.repository.getRouteSnapshot(
      request.routeId,
    );
    const snapshot =
      storedSnapshot === null
        ? null
        : {
            ...storedSnapshot,
            providers: storedSnapshot.providers.filter(
              (provider) =>
                provider.enabled &&
                isProviderSecretConfigured(provider, this.secrets) &&
                (!requestHasImages(request) || supportsImageInput(provider)) &&
                (request.webSearch === undefined ||
                  request.webSearch === "disabled" ||
                  supportsHostedSearch(provider) ||
                  (request.tools !== undefined &&
                    supportsLocalTools(provider))),
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
      const candidates = selection.candidates
        .filter(
          (candidate) =>
            retryableProviderIds === null ||
            retryableProviderIds.has(candidate.provider.id),
        )
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
        const useHostedSearch =
          request.webSearch !== undefined &&
          request.webSearch !== "disabled" &&
          supportsHostedSearch(candidate.provider);
        let result: AiCallResult = await this.client.call(candidate.provider, {
          messages: request.messages,
          maxOutputTokens: request.maxOutputTokens,
          temperature: request.temperature,
          clientRequestId: `${request.executionId}:${request.nodeId}:${round}:${sequence}`,
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
          return {
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
        if (
          (!snapshot.route.fallbackEnabled && !result.retryable) ||
          !result.fallbackAllowed
        ) {
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
