import { z } from "zod";

export type BlueBubblesSendMethod = "private-api" | "apple-script";

export interface BlueBubblesRuntimeSettings {
  serverUrl: string;
  accessToken: string;
  webhookSecret: string;
  sendMethod: BlueBubblesSendMethod;
  requestTimeoutMs: number;
}

export interface BlueBubblesSettingsView {
  serverUrl: string;
  accessTokenConfigured: boolean;
  webhookSecretConfigured: boolean;
  sendMethod: BlueBubblesSendMethod;
  requestTimeoutMs: number;
  source: "environment" | "database";
  version: number;
  updatedAt: string | null;
}

export interface BlueBubblesConnectionTestResult {
  status: "connected" | "failed";
  durationMs: number;
  code: string | null;
  message: string;
}

export const blueBubblesSettingsUpdateSchema = z.object({
  serverUrl: z
    .string()
    .url()
    .transform((value) => value.replace(/\/$/u, "")),
  accessToken: z.string().min(1).max(4_096).optional(),
  webhookSecret: z.string().min(32).max(4_096).optional(),
  sendMethod: z.enum(["private-api", "apple-script"]),
  requestTimeoutMs: z.number().int().min(1_000).max(120_000),
  expectedVersion: z.number().int().nonnegative(),
});

export type BlueBubblesSettingsUpdate = z.infer<
  typeof blueBubblesSettingsUpdateSchema
>;
