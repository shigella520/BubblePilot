import { z } from "zod";
export const imageExportProtocol = "io.bubblepilot/image-export";
export const generatedImageLimits = {
  bytes: 8 * 1024 * 1024,
  pixels: 16_000_000,
  edge: 8192,
} as const;
export const imageReplySchema = z
  .object({
    enabled: z.boolean().default(false),
    pluginId: z.union([z.string().uuid(), z.literal("")]),
    server: z.string().max(200),
  })
  .strict()
  .refine((v) => !v.enabled || !!(v.pluginId && v.server), {
    message: "Choose the image reply sandbox",
  });
export type ImageReply = z.infer<typeof imageReplySchema>;
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
