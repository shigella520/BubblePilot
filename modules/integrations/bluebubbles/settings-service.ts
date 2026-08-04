import { secretsEqual } from "../../../app/security.js";
import type { SettingsCipher } from "./settings-cipher.js";
import type { BlueBubblesSettingsRepository } from "./settings-repository.js";
import type {
  BlueBubblesRuntimeSettings,
  BlueBubblesConnectionTestResult,
  BlueBubblesSettingsUpdate,
  BlueBubblesSettingsView,
} from "./settings-types.js";

export class BlueBubblesSettingsService {
  constructor(
    readonly repository: BlueBubblesSettingsRepository,
    private readonly cipher: SettingsCipher,
    private readonly fallback: BlueBubblesRuntimeSettings,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async view(): Promise<BlueBubblesSettingsView> {
    const stored = await this.repository.find();
    return stored === null
      ? {
          serverUrl: this.fallback.serverUrl,
          accessTokenConfigured: this.fallback.accessToken.length > 0,
          webhookSecretConfigured: this.fallback.webhookSecret.length >= 32,
          sendMethod: this.fallback.sendMethod,
          requestTimeoutMs: this.fallback.requestTimeoutMs,
          source: "environment",
          version: 0,
          updatedAt: null,
        }
      : {
          serverUrl: stored.serverUrl,
          accessTokenConfigured: stored.encryptedAccessToken.length > 0,
          webhookSecretConfigured: stored.encryptedWebhookSecret.length > 0,
          sendMethod: stored.sendMethod,
          requestTimeoutMs: stored.requestTimeoutMs,
          source: "database",
          version: stored.version,
          updatedAt: stored.updatedAt,
        };
  }

  async resolve(): Promise<BlueBubblesRuntimeSettings> {
    const stored = await this.repository.find();
    return stored === null
      ? this.fallback
      : {
          serverUrl: stored.serverUrl,
          accessToken: this.cipher.decrypt(stored.encryptedAccessToken),
          webhookSecret: this.cipher.decrypt(stored.encryptedWebhookSecret),
          sendMethod: stored.sendMethod,
          requestTimeoutMs: stored.requestTimeoutMs,
        };
  }

  async update(
    input: BlueBubblesSettingsUpdate,
  ): Promise<
    { status: "ok"; value: BlueBubblesSettingsView } | { status: "conflict" }
  > {
    const currentSettings = await this.resolve();
    const result = await this.repository.save({
      serverUrl: input.serverUrl,
      encryptedAccessToken: this.cipher.encrypt(
        input.accessToken ?? currentSettings.accessToken,
      ),
      encryptedWebhookSecret: this.cipher.encrypt(
        input.webhookSecret ?? currentSettings.webhookSecret,
      ),
      sendMethod: input.sendMethod,
      requestTimeoutMs: input.requestTimeoutMs,
      expectedVersion: input.expectedVersion,
    });
    if (result.status === "conflict") return result;
    return {
      status: "ok",
      value: {
        serverUrl: result.value.serverUrl,
        accessTokenConfigured: true,
        webhookSecretConfigured: true,
        sendMethod: result.value.sendMethod,
        requestTimeoutMs: result.value.requestTimeoutMs,
        source: "database",
        version: result.value.version,
        updatedAt: result.value.updatedAt,
      },
    };
  }

  async verifyWebhookSecret(candidate: string | undefined): Promise<boolean> {
    const settings = await this.resolve();
    return secretsEqual(candidate, settings.webhookSecret);
  }

  async testConnection(): Promise<BlueBubblesConnectionTestResult> {
    const settings = await this.resolve();
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      settings.requestTimeoutMs,
    );
    try {
      const endpoint = new URL("/api/v1/server/info", `${settings.serverUrl}/`);
      endpoint.searchParams.set("password", settings.accessToken);
      const response = await this.fetchImplementation(endpoint, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        const code =
          response.status === 401 || response.status === 403
            ? "BLUEBUBBLES_INVALID_ACCESS_TOKEN"
            : `BLUEBUBBLES_HTTP_${response.status}`;
        return {
          status: "failed",
          durationMs: Date.now() - startedAt,
          code,
          message:
            response.status === 401 || response.status === 403
              ? "BlueBubbles 拒绝了 Access Token。"
              : `BlueBubbles 服务返回 HTTP ${response.status}。`,
        };
      }
      return {
        status: "connected",
        durationMs: Date.now() - startedAt,
        code: null,
        message: "BlueBubbles REST API 连接成功。",
      };
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (error.name === "AbortError" || controller.signal.aborted);
      return {
        status: "failed",
        durationMs: Date.now() - startedAt,
        code: timedOut
          ? "BLUEBUBBLES_CONNECTION_TIMEOUT"
          : "BLUEBUBBLES_CONNECTION_FAILED",
        message: timedOut
          ? "连接 BlueBubbles 超时，请检查地址和网络。"
          : "无法连接 BlueBubbles，请检查 Server URL、网络和服务状态。",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
