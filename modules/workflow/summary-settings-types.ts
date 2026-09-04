import { z } from "zod";

export interface SummaryRuntimeSettings {
  enabled: boolean;
  includeFromMe: boolean;
  baseMessageWindow: number;
  characterLimit: number;
  redundancyMessageWindow: number;
  providerRouteId: string;
  timeZone: string;
  policyVersion?: number;
}

export interface SummarySettingsView extends SummaryRuntimeSettings {
  source: "defaults" | "database";
  version: number;
  policyVersion: number;
  updatedAt: string | null;
}

export const summarySettingsUpdateSchema = z
  .object({
    enabled: z.boolean(),
    includeFromMe: z.boolean().default(true),
    baseMessageWindow: z.number().int().min(1).max(50),
    characterLimit: z.number().int().min(100).max(20_000),
    redundancyMessageWindow: z.number().int().min(1).max(50),
    providerRouteId: z.string().uuid().or(z.literal("")),
    timeZone: z.string().trim().min(1).max(100),
    expectedVersion: z.number().int().min(0),
  })
  .superRefine((value, context) => {
    if (value.enabled && value.providerRouteId === "") {
      context.addIssue({
        code: "custom",
        path: ["providerRouteId"],
        message:
          "A summary Provider route is required when summary is enabled.",
      });
    }
  });

export type SummarySettingsUpdate = z.infer<typeof summarySettingsUpdateSchema>;
