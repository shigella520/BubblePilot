import type { BlueBubblesSendMethod } from "./settings-types.js";

export interface BlueBubblesSettingsRecord {
  serverUrl: string;
  encryptedAccessToken: string;
  encryptedWebhookSecret: string;
  sendMethod: BlueBubblesSendMethod;
  requestTimeoutMs: number;
  linkPreviewEnabled: boolean;
  openGraphFallbackEnabled: boolean;
  openGraphTimeoutMs: number;
  version: number;
  updatedAt: string;
}

export interface BlueBubblesSettingsRepository {
  find(): Promise<BlueBubblesSettingsRecord | null>;
  save(input: {
    serverUrl: string;
    encryptedAccessToken: string;
    encryptedWebhookSecret: string;
    sendMethod: BlueBubblesSendMethod;
    requestTimeoutMs: number;
    linkPreviewEnabled: boolean;
    openGraphFallbackEnabled: boolean;
    openGraphTimeoutMs: number;
    expectedVersion: number;
  }): Promise<
    { status: "ok"; value: BlueBubblesSettingsRecord } | { status: "conflict" }
  >;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
