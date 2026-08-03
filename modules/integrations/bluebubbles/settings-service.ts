import { secretsEqual } from "../../../app/security.js";
import type { SettingsCipher } from "./settings-cipher.js";
import type { BlueBubblesSettingsRepository } from "./settings-repository.js";
import type {
  BlueBubblesRuntimeSettings,
  BlueBubblesSettingsUpdate,
  BlueBubblesSettingsView,
} from "./settings-types.js";

export class BlueBubblesSettingsService {
  constructor(
    readonly repository: BlueBubblesSettingsRepository,
    private readonly cipher: SettingsCipher,
    private readonly fallback: BlueBubblesRuntimeSettings,
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
}
