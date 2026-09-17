import { z } from "zod";

export interface ContextRuntimeSettings {
  includeFromMe: boolean;
  baseMessageWindow: number;
  characterLimit: number;
  redundancyMessageWindow: number;
}

export interface ContextSettingsView extends ContextRuntimeSettings {
  source: "defaults" | "database";
  version: number;
  updatedAt: string | null;
}

export const contextSettingsUpdateSchema = z
  .object({
    includeFromMe: z.boolean().default(true),
    baseMessageWindow: z.number().int().min(1).max(50),
    characterLimit: z.number().int().min(100).max(20_000),
    redundancyMessageWindow: z.number().int().min(1).max(50),
    expectedVersion: z.number().int().min(0),
  })
  .strict();

export type ContextSettingsUpdate = z.infer<typeof contextSettingsUpdateSchema>;
