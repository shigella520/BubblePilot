import { z } from "zod";
export const imageExportProtocol = "io.bubblepilot/image-export";
export const fileExportProtocol = "io.bubblepilot/file-export";
export const replyFileTypes = [
  "png",
  "jpeg",
  "gif",
  "pdf",
  "xlsx",
  "csv",
  "txt",
  "md",
  "zip",
] as const;
export type ReplyFileType = (typeof replyFileTypes)[number];
export const generatedFileLimits = {
  bytes: 20 * 1024 * 1024,
  entries: 200,
  expandedBytes: 50 * 1024 * 1024,
} as const;
export const generatedImageLimits = {
  bytes: 8 * 1024 * 1024,
  pixels: 16_000_000,
  edge: 8192,
} as const;
export const generatedGifLimits = {
  frames: 200,
  totalPixels: 64_000_000,
} as const;
export const imageReplySchema = z
  .object({
    enabled: z.boolean().default(false),
    pluginId: z.union([z.string().uuid(), z.literal("")]),
    server: z.string().max(200),
    // Omission is the persisted PNG-only contract, never permission for all files.
    allowedTypes: z
      .array(z.enum(replyFileTypes))
      .min(1)
      .max(replyFileTypes.length)
      .refine((v) => new Set(v).size === v.length)
      .optional(),
  })
  .strict()
  .refine((v) => !v.enabled || !!(v.pluginId && v.server), {
    message: "Choose the image reply sandbox",
  });
export type ImageReply = z.infer<typeof imageReplySchema>;
/**
 * Optional generator target (an MCP image model plugin) bound alongside the
 * sandbox. It imports chat images and returns PNG reply attachments; both
 * reach the same Reply node as sandbox attachments.
 */
export const imageGenerationSchema = z
  .object({
    enabled: z.boolean().default(false),
    pluginId: z.union([z.string().uuid(), z.literal("")]),
    server: z.string().max(200),
  })
  .strict()
  .refine((v) => !v.enabled || !!(v.pluginId && v.server), {
    message: "Choose the image generator before enabling",
  });
export type ImageGeneration = z.infer<typeof imageGenerationSchema>;
export interface ImageGeneratorBinding {
  pluginId: string;
  server: string;
}
/** Reply attachments are available from a sandbox, a generator or both. */
export function replyAttachmentsEnabled(config: {
  imageReply?: ImageReply | undefined;
  imageGeneration?: ImageGeneration | undefined;
}) {
  return !!(config.imageReply?.enabled || config.imageGeneration?.enabled);
}
export function allowedReplyFileTypes(
  config: ImageReply,
): readonly ReplyFileType[] {
  return config.allowedTypes ?? ["png"];
}
export function needsFileExport(config: ImageReply) {
  return allowedReplyFileTypes(config).some((type) => type !== "png");
}
export interface GeneratedImageRef {
  id: string;
  sha256: string;
  executionId: string;
}
export class GeneratedImageError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
