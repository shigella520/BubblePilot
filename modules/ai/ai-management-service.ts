import type { AiClient } from "./openai-compatible-client.js";
import type { AiMutationResult, AiRepository } from "./ai-repository.js";
import {
  normalizeAiBaseUrl,
  type AiProviderConfiguration,
  type AiProviderRecord,
  type AiProviderRouteRecord,
  type AiProviderRouteView,
  type AiProviderTestResult,
  type AiProviderView,
  type AiRouteConfiguration,
  type WebSearchPolicy,
} from "./ai-types.js";
import {
  isProviderSecretConfigured,
  type SecretResolver,
} from "./secret-resolver.js";

export class AiManagementService {
  constructor(
    private readonly repository: AiRepository,
    private readonly client: AiClient,
    private readonly secrets: SecretResolver,
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
      timeoutMs: provider.requestTimeoutMs,
    });
    let capabilityErrorCode: string | null = null;
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
        timeoutMs: provider.requestTimeoutMs,
        webSearch: "required",
      });
      await this.repository.updateProviderCapabilityProbe(providerId, {
        functionCalling:
          searchProbe.status === "succeeded" ? "verified" : "failed",
        hostedWebSearch:
          searchProbe.status === "succeeded" ? "verified" : "failed",
        checkedAt: new Date().toISOString(),
      });
      if (searchProbe.status === "failed") {
        capabilityErrorCode = searchProbe.code;
      }
    }
    return result.status === "succeeded" && capabilityErrorCode === null
      ? {
          success: true,
          providerId,
          model: provider.model,
          durationMs: result.durationMs,
          errorCode: null,
          message: "The AI provider connection succeeded.",
        }
      : {
          success: false,
          providerId,
          model: provider.model,
          durationMs: result.durationMs,
          errorCode:
            capabilityErrorCode ??
            (result.status === "failed" ? result.code : "AI_WEB_SEARCH_FAILED"),
          message:
            capabilityErrorCode === null && result.status === "failed"
              ? result.summary
              : "The configured hosted web search capability failed its probe.",
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
    const searchable = available.filter(
      (provider) =>
        provider.apiKind === "responses" &&
        provider.capabilities?.hostedWebSearch === true &&
        provider.capabilityProbe?.hostedWebSearch === "verified",
    );
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
