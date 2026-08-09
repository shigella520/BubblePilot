import type { AiClient } from "./openai-compatible-client.js";
import type { WebSearchTool } from "./web-search-tool.js";
import type { AiMutationResult, AiRepository } from "./ai-repository.js";
import {
  normalizeAiBaseUrl,
  type AiCallResult,
  type AiChatRequest,
  type AiProviderConfiguration,
  type AiProviderRecord,
  type AiProviderRouteRecord,
  type AiProviderRouteView,
  type AiProviderTestCheck,
  type AiProviderTestResult,
  type AiProviderView,
  type AiRouteConfiguration,
  type WebSearchPolicy,
} from "./ai-types.js";
import {
  isProviderSecretConfigured,
  type SecretResolver,
} from "./secret-resolver.js";

const imageCapabilityProbeDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAABgCAIAAADjKTx/AAAD8ElEQVR4nO3TQZZkIQhEUfe/6apxD9oDEqBR/91ppoD4Y/0AsLVuDwDgHAEGjBFgwBgBBowRYMAYAQaMEWDAGAEGjBFgwBgBBowRYMAYAQaMEWDAGAEGjBFgwBgBBowRYMAYAQaMEWDAGAEGjBFgwBgBBowRYMBYNMDrX7ke27NLJzVGpbJuZOXMlVfoO5uqXCGsLLxRbT2BdtH/FcbqW3RqKmFl3cgEWEZYWXij2noC7aL/K4zVt+jUVMLKupEJsIywsvBGtfUE2kX/Vxirb9GpqYSVdSMTYBlhZeGNausJtIv+rzBW36JTUwkr60YmwDLCysIb1dYTaBf9X2Esx7MVb9638sne2uRe31SV5QzvigDrvXnfynd2a5N7fVNVljO8KwKs9+Z9K9/ZrU3u9U1VWc7wrgiw3pv3rXxntza51zdVZTnDuyLAem/et/Kd3drkXt9UleUM74oA671538p3dmuTt8Yw+uoIsN6b911bfVMJjY1h9NURYL0377u2+qYSGhvD6KsjwHpv3ndt9U0lNDaG0VdHgPXevO/a6ptKaGwMo6/uLwd4X6ryQffN3He279c+X3v9k3bR/7V9WH1n96XefMK+s32/9vna65+0i/6v7cPqO7sv9eYT9p3t+7XP117/pF30f20fVt/Zfak3n7DvbN+vfb72+iftov9r+7D6zu5LvfmEfWf7fu3ztdc/aXd4bOq9HT+dN8+mKv/nw25/hVvPLRxj+AoEWN/3zbOpymsrNZXwCmNuveABAqzv++bZVOW1lZpKeIUxt17wAAHW933zbKry2kpNJbzCmFsveIAA6/u+eTZVeW2lphJeYcytFzxAgPV93zybqry2UlMJrzDm1gseIMD6vm+eTVVeW6mphFcYc+sFDxBgfd83z6Yqr63UVMIrjLn1ggcIsL7vm2dTlddWairhFcbcesEDBFjf982zqcprKzWV8Apjbr3gAU0D4YUrhJVvzVxplCoVexzB2VuNjl5DsBxh5VB3TZWp+6e2Iyw1NnOlUapU7HEEZ281OnoNwXKElUPdNVWm7p/ajrDU2MyVRqlSsccRnL3V6Og1BMsRVg5111SZun9qO8JSYzNXGqVKxR5HcPZWo6PXECxHWDnUXVNl6v6p7QhLjc1caZQqFXscwdlbjY5eQ7AcYeVQd3lFAGMIMGCMAAPGCDBgjAADxggwYIwAA8YIMGCMAAPGCDBgjAADxggwYIwAA8YIMGCMAAPGCDBgjAADxggwYIwAA8YIMGCMAAPGCDBgjAADxggwYIwAA8YIMGCMAAPGCDBgjAADxggwYIwAA8YIMGCMAAPGCDBgjAADxggwYIwAA8Z+Aa+3BZurxA9AAAAAAElFTkSuQmCC";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function probeCheck(
  name: AiProviderTestCheck["name"],
  result: AiCallResult,
  attempts: number,
  durationMs: number,
  verified = result.status === "succeeded",
  mismatchCode: string | null = null,
  responsePreview: string | null = null,
): AiProviderTestCheck {
  return {
    name,
    status: verified ? "verified" : "failed",
    attempts,
    durationMs,
    errorCode:
      result.status === "failed" ? result.code : verified ? null : mismatchCode,
    httpStatus: result.diagnostics?.httpStatus ?? null,
    providerRequestId: result.diagnostics?.providerRequestId ?? null,
    responsePreview,
  };
}

function probeResponsePreview(result: AiCallResult): string | null {
  if (result.status === "failed") return null;
  const sanitized = Array.from(result.text, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
      ? " "
      : character;
  }).join("");
  const normalized = sanitized.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return "(empty response)";
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 159)}…`;
}

function checkMessage(check: AiProviderTestCheck): string {
  const labels: Record<AiProviderTestCheck["name"], string> = {
    connectivity: "Connection",
    functionCalling: "Function Calling",
    hostedWebSearch: "Hosted web search",
    imageInput: "Image input",
  };
  if (check.status === "verified") {
    return `${labels[check.name]} verified`;
  }
  const diagnostics = [
    check.errorCode,
    check.httpStatus === null ? null : `HTTP ${check.httpStatus}`,
    `${check.attempts} attempt${check.attempts === 1 ? "" : "s"}`,
    `${check.durationMs} ms`,
  ].filter((part): part is string => part !== null);
  return `${labels[check.name]} failed (${diagnostics.join(", ")})`;
}

function imageProbeAnswerVerified(result: AiCallResult): boolean {
  if (result.status === "failed") return false;
  const normalized = result.text.toLocaleUpperCase("en-US");
  const word = normalized.indexOf("VISION");
  const code = normalized.indexOf("731");
  return word >= 0 && word < code;
}

async function probeWithRetry(
  client: AiClient,
  provider: AiProviderRecord,
  request: AiChatRequest,
  maxAttempts: number,
): Promise<{ result: AiCallResult; attempts: number; durationMs: number }> {
  let attempts = 0;
  let durationMs = 0;
  let result: AiCallResult;
  do {
    attempts += 1;
    result = await client.call(provider, request);
    durationMs += result.durationMs;
    if (result.status === "succeeded" || !result.retryable) break;
    if (attempts < maxAttempts) await delay(250);
  } while (attempts < maxAttempts);
  return { result, attempts, durationMs };
}

export class AiManagementService {
  constructor(
    private readonly repository: AiRepository,
    private readonly client: AiClient,
    private readonly secrets: SecretResolver,
    private readonly localWebSearchEnabled = false,
    private readonly searchTool?: WebSearchTool,
  ) {}

  async listProviders(): Promise<readonly AiProviderView[]> {
    return Promise.all(
      (await this.repository.listProviders()).map((provider) =>
        this.providerView(provider),
      ),
    );
  }

  async getProvider(providerId: string): Promise<AiProviderView | null> {
    const provider = await this.repository.getProvider(providerId);
    return provider === null ? null : this.providerView(provider);
  }

  async createProvider(
    configuration: AiProviderConfiguration,
  ): Promise<AiMutationResult<AiProviderView>> {
    return this.mapProviderMutation(
      await this.repository.createProvider(
        this.normalizeProvider(configuration),
      ),
    );
  }

  async updateProvider(
    providerId: string,
    expectedVersion: number,
    configuration: AiProviderConfiguration,
  ): Promise<AiMutationResult<AiProviderView>> {
    return this.mapProviderMutation(
      await this.repository.updateProvider(
        providerId,
        expectedVersion,
        this.normalizeProvider(configuration),
      ),
    );
  }

  async setProviderEnabled(
    providerId: string,
    expectedVersion: number,
    enabled: boolean,
  ): Promise<AiMutationResult<AiProviderView>> {
    return this.mapProviderMutation(
      await this.repository.setProviderEnabled(
        providerId,
        expectedVersion,
        enabled,
      ),
    );
  }

  async reorderProviders(
    providers: readonly { id: string; expectedVersion: number }[],
  ): Promise<AiMutationResult<readonly AiProviderView[]>> {
    const result = await this.repository.reorderProviders(providers);
    if (result.status !== "ok") {
      return result;
    }
    return {
      status: "ok",
      value: await Promise.all(
        result.value.map((provider) => this.providerView(provider)),
      ),
    };
  }

  async deleteProvider(
    providerId: string,
    expectedVersion: number,
  ): Promise<AiMutationResult<AiProviderView>> {
    return this.mapProviderMutation(
      await this.repository.deleteProvider(providerId, expectedVersion),
    );
  }

  async resetProviderHealth(
    providerId: string,
  ): Promise<AiProviderView | null> {
    const health = await this.repository.resetProviderHealth(providerId);
    if (health === null) {
      return null;
    }
    return this.getProvider(providerId);
  }

  async testProvider(providerId: string): Promise<AiProviderTestResult | null> {
    const provider = await this.repository.getProvider(providerId);
    if (provider === null) {
      return null;
    }
    const result = await this.client.call(provider, {
      messages: [
        {
          role: "user",
          content: "Connectivity test. Reply with the single word OK.",
        },
      ],
      // Reasoning-capable OpenAI-compatible models may consume the first
      // tokens internally before producing assistant content. Keep the
      // connectivity probe small, but large enough to receive its final OK.
      maxOutputTokens: 128,
      temperature: 0,
    });
    let functionCalling: "verified" | "failed" | "unknown" = "unknown";
    let hostedWebSearch: "verified" | "failed" | "unknown" = "unknown";
    let imageInput: "verified" | "failed" | "unknown" = "unknown";
    const checks: AiProviderTestCheck[] = [
      probeCheck("connectivity", result, 1, result.durationMs),
    ];
    let totalDurationMs = result.durationMs;
    if (
      result.status === "succeeded" &&
      provider.capabilities?.functionCalling
    ) {
      const functionProbe = await this.client.call(provider, {
        messages: [
          {
            role: "user",
            content: "Call the capability_probe tool exactly once.",
          },
        ],
        maxOutputTokens: 128,
        temperature: 0,
        tools: [
          {
            name: "capability_probe",
            description:
              "A harmless tool used only to verify function calling.",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
        toolChoice: "required",
      });
      totalDurationMs += functionProbe.durationMs;
      functionCalling =
        functionProbe.status === "succeeded" &&
        (functionProbe.toolCalls?.some(
          (call) => call.name === "capability_probe",
        ) ??
          false)
          ? "verified"
          : "failed";
      checks.push(
        probeCheck(
          "functionCalling",
          functionProbe,
          1,
          functionProbe.durationMs,
          functionCalling === "verified",
          "AI_FUNCTION_PROBE_MISMATCH",
        ),
      );
    }
    if (
      result.status === "succeeded" &&
      provider.capabilities?.hostedWebSearch
    ) {
      const searchProbe = await this.client.call(provider, {
        messages: [
          {
            role: "user",
            content:
              "Capability test. Search the web for the official OpenAI website and reply with OK.",
          },
        ],
        maxOutputTokens: 128,
        temperature: 0,
        webSearch: "required",
      });
      totalDurationMs += searchProbe.durationMs;
      hostedWebSearch =
        searchProbe.status === "succeeded" ? "verified" : "failed";
      checks.push(
        probeCheck("hostedWebSearch", searchProbe, 1, searchProbe.durationMs),
      );
    }
    if (result.status === "succeeded" && provider.capabilities?.imageInput) {
      const imageProbe = await probeWithRetry(
        this.client,
        provider,
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Image capability test v2. Read the large text shown in this image. Reply with only that text.",
                },
                {
                  type: "image",
                  dataUrl: imageCapabilityProbeDataUrl,
                  detail: "low",
                  label: "capability probe",
                },
              ],
            },
          ],
          maxOutputTokens: 512,
          temperature: 0,
        },
        2,
      );
      totalDurationMs += imageProbe.durationMs;
      const imageVerified = imageProbeAnswerVerified(imageProbe.result);
      imageInput = imageVerified ? "verified" : "failed";
      checks.push(
        probeCheck(
          "imageInput",
          imageProbe.result,
          imageProbe.attempts,
          imageProbe.durationMs,
          imageVerified,
          "AI_IMAGE_PROBE_MISMATCH",
          imageVerified ? null : probeResponsePreview(imageProbe.result),
        ),
      );
    }
    if (result.status === "succeeded") {
      await this.repository.updateProviderCapabilityProbe(providerId, {
        functionCalling,
        hostedWebSearch,
        imageInput,
        checkedAt: new Date().toISOString(),
      });
    }
    return result.status === "succeeded"
      ? {
          success: true,
          providerId,
          model: provider.model,
          durationMs: totalDurationMs,
          errorCode: null,
          message: [...checks.map(checkMessage)].join(" "),
          checks,
        }
      : {
          success: false,
          providerId,
          model: provider.model,
          durationMs: totalDurationMs,
          errorCode: result.code,
          message: checkMessage(checks[0]!),
          checks,
        };
  }

  async listRoutes(): Promise<readonly AiProviderRouteView[]> {
    return Promise.all(
      (await this.repository.listRoutes()).map((route) =>
        this.routeView(route),
      ),
    );
  }

  async getRoute(routeId: string): Promise<AiProviderRouteView | null> {
    const route = await this.repository.getRoute(routeId);
    return route === null ? null : this.routeView(route);
  }

  async isRoutePublishable(
    routeId: string,
    webSearch: WebSearchPolicy = "disabled",
  ): Promise<boolean> {
    const route = await this.repository.getRoute(routeId);
    if (route === null || !route.enabled) {
      return false;
    }
    const providers = await this.repository.listProviders();
    const configured =
      route.providerIds.length === 0
        ? providers
        : route.providerIds.flatMap((providerId) => {
            const provider = providers.find(
              (candidate) => candidate.id === providerId,
            );
            return provider === undefined ? [] : [provider];
          });
    const available = configured.filter(
      (provider) =>
        provider.enabled && isProviderSecretConfigured(provider, this.secrets),
    );
    if (webSearch === "disabled") return available.length > 0;
    const localWebSearchReady =
      this.localWebSearchEnabled &&
      this.searchTool !== undefined &&
      (await this.searchTool.isReady());
    const searchable = available.filter((provider) => {
      const hosted =
        provider.apiKind === "responses" &&
        provider.capabilities?.hostedWebSearch === true &&
        provider.capabilityProbe?.hostedWebSearch === "verified";
      const local =
        localWebSearchReady &&
        provider.capabilities?.functionCalling === true &&
        provider.capabilityProbe?.functionCalling === "verified";
      return hosted || local;
    });
    return webSearch === "required"
      ? searchable.length === available.length && available.length > 0
      : searchable.length > 0;
  }

  async createRoute(
    configuration: AiRouteConfiguration,
  ): Promise<AiMutationResult<AiProviderRouteView>> {
    return this.mapRouteMutation(
      await this.repository.createRoute(configuration),
    );
  }

  async updateRoute(
    routeId: string,
    expectedVersion: number,
    configuration: AiRouteConfiguration,
  ): Promise<AiMutationResult<AiProviderRouteView>> {
    return this.mapRouteMutation(
      await this.repository.updateRoute(
        routeId,
        expectedVersion,
        configuration,
      ),
    );
  }

  async setRouteEnabled(
    routeId: string,
    expectedVersion: number,
    enabled: boolean,
  ): Promise<AiMutationResult<AiProviderRouteView>> {
    return this.mapRouteMutation(
      await this.repository.setRouteEnabled(routeId, expectedVersion, enabled),
    );
  }

  async deleteRoute(
    routeId: string,
    expectedVersion: number,
  ): Promise<AiMutationResult<AiProviderRouteView>> {
    return this.mapRouteMutation(
      await this.repository.deleteRoute(routeId, expectedVersion),
    );
  }

  private normalizeProvider(
    configuration: AiProviderConfiguration,
  ): AiProviderConfiguration {
    return {
      ...configuration,
      baseUrl: normalizeAiBaseUrl(configuration.baseUrl),
      capabilities: configuration.capabilities ?? {
        functionCalling: false,
        hostedWebSearch: false,
        imageInput: false,
      },
    };
  }

  private async providerView(
    provider: AiProviderRecord,
  ): Promise<AiProviderView> {
    const health = await this.repository.getProviderHealth(provider.id);
    if (health === null) {
      throw new Error(`AI provider health '${provider.id}' does not exist.`);
    }
    const safeProvider = { ...provider };
    delete safeProvider.secret;
    delete safeProvider.secretRef;
    return {
      ...safeProvider,
      secretConfigured: isProviderSecretConfigured(provider, this.secrets),
      health,
      capabilityProbe: provider.capabilityProbe ?? {
        functionCalling: "unknown",
        hostedWebSearch: "unknown",
        imageInput: "unknown",
        checkedAt: null,
      },
    };
  }

  private async routeView(
    route: AiProviderRouteRecord,
  ): Promise<AiProviderRouteView> {
    const providers = await this.repository.listProviders();
    const configuredProviderIds = [...route.providerIds];
    const candidateIds =
      configuredProviderIds.length === 0
        ? providers.map((provider) => provider.id)
        : configuredProviderIds;
    const storedSnapshot = await this.repository.getRouteSnapshot(route.id);
    const selection =
      storedSnapshot === null
        ? null
        : await this.repository.selectCandidates({
            ...storedSnapshot,
            providers: storedSnapshot.providers.filter(
              (provider) =>
                provider.enabled &&
                isProviderSecretConfigured(provider, this.secrets),
            ),
          });
    const effectiveProviderIds =
      selection?.candidates.map((candidate) => candidate.provider.id) ?? [];
    return {
      ...route,
      configuredProviderIds,
      effectiveProviderIds,
      unavailableProviderIds: candidateIds.filter(
        (providerId) => !effectiveProviderIds.includes(providerId),
      ),
    };
  }

  private async mapProviderMutation(
    result: AiMutationResult<AiProviderRecord>,
  ): Promise<AiMutationResult<AiProviderView>> {
    return result.status === "ok"
      ? { status: "ok", value: await this.providerView(result.value) }
      : result;
  }

  private async mapRouteMutation(
    result: AiMutationResult<AiProviderRouteRecord>,
  ): Promise<AiMutationResult<AiProviderRouteView>> {
    return result.status === "ok"
      ? { status: "ok", value: await this.routeView(result.value) }
      : result;
  }
}
