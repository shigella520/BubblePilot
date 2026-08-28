import { z } from "zod";

export interface SummaryRuntimeSettings {
  enabled: boolean;
  messageLimit: number;
  characterLimit: number;
  compressionBatchSize: number;
  providerRouteId: string;
  timeZone: string;
}

export interface SummarySettingsView extends SummaryRuntimeSettings {
  source: "defaults" | "database";
  version: number;
  policyVersion: number;
  updatedAt: string | null;
}

export const summarySettingsUpdateSchema = z.object({
  enabled: z.boolean(),
  messageLimit: z.number().int().min(1).max(50),
  characterLimit: z.number().int().min(100).max(20_000),
  compressionBatchSize: z.number().int().min(1).max(50),
  providerRouteId: z.string().uuid().or(z.literal("")),
  timeZone: z.string().trim().min(1).max(100),
  expectedVersion: z.number().int().min(0),
});

export type SummarySettingsUpdate = z.infer<typeof summarySettingsUpdateSchema>;
