import { z } from "zod";

import type { WebSearchFailurePolicy } from "./ai-types.js";

export interface WebSearchRuntimeSettings {
  maxAttempts: number;
  attemptTimeoutMs: number;
  retryDelayMs: number;
  maxResults: number;
  failurePolicy: WebSearchFailurePolicy;
}

export interface WebSearchSettingsView extends WebSearchRuntimeSettings {
  source: "defaults" | "database";
  version: number;
  updatedAt: string | null;
}

const runtimeFields = {
  maxAttempts: z.number().int().min(1).max(5),
  attemptTimeoutMs: z.number().int().min(1_000).max(60_000),
  retryDelayMs: z.number().int().min(0).max(5_000),
  maxResults: z.number().int().min(1).max(20),
  failurePolicy: z.enum(["mode-default", "fail", "continue"]),
};

export const webSearchSettingsUpdateSchema = z.object({
  ...runtimeFields,
  expectedVersion: z.number().int().min(0),
});

export type WebSearchSettingsUpdate = z.infer<
  typeof webSearchSettingsUpdateSchema
>;
