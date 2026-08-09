import { z } from "zod";

export type ImageDetail = "low" | "high" | "auto";

export interface ImageInputRuntimeSettings {
  enabled: boolean;
  includeAttachments: boolean;
  includeLinkPreviewImages: boolean;
  maxCurrentAttachments: number;
  maxHistoryImages: number;
  maxTotalImages: number;
  maxImageBytes: number;
  maxTotalBytes: number;
  fetchTimeoutMs: number;
  detail: ImageDetail;
}

export interface ImageInputSettingsView extends ImageInputRuntimeSettings {
  source: "defaults" | "database";
  version: number;
  updatedAt: string | null;
}

const runtimeFields = {
  enabled: z.boolean(),
  includeAttachments: z.boolean(),
  includeLinkPreviewImages: z.boolean(),
  maxCurrentAttachments: z.number().int().min(1).max(10),
  maxHistoryImages: z.number().int().min(0).max(10),
  maxTotalImages: z.number().int().min(1).max(20),
  maxImageBytes: z.number().int().min(1_024).max(52_428_800),
  maxTotalBytes: z.number().int().min(1_024).max(104_857_600),
  fetchTimeoutMs: z.number().int().min(1_000).max(60_000),
  detail: z.enum(["low", "high", "auto"]),
};

export const imageInputSettingsUpdateSchema = z
  .object({
    ...runtimeFields,
    expectedVersion: z.number().int().min(0),
  })
  .refine((value) => value.maxTotalImages >= value.maxCurrentAttachments, {
    message: "The total image limit must cover the current attachment limit.",
  })
  .refine((value) => value.maxTotalBytes >= value.maxImageBytes, {
    message: "The total byte limit must cover the per-image byte limit.",
  });

export type ImageInputSettingsUpdate = z.infer<
  typeof imageInputSettingsUpdateSchema
>;
