import { z } from "zod";
export const attachmentLimitsSchema = z
  .object({
    fileMiB: z.number().int().min(1).max(20).default(10),
    files: z.number().int().min(1).max(5).default(3),
    totalMiB: z.number().int().min(1).max(50).default(20),
    timeoutSeconds: z.number().int().min(5).max(180).default(30),
    expandedMiB: z.number().int().min(1).max(100).default(50),
    expandedFiles: z.number().int().min(1).max(500).default(200),
  })
  .strict()
  .refine((v) => v.totalMiB >= v.fileMiB);
export const attachmentHandlingSchema = z
  .object({
    enabled: z.boolean().default(false),
    pluginId: z.union([z.string().uuid(), z.literal("")]),
    server: z.string().max(200),
    limits: attachmentLimitsSchema.default(() =>
      attachmentLimitsSchema.parse({}),
    ),
  })
  .strict()
  .refine((v) => !v.enabled || !!(v.pluginId && v.server), {
    message: "Choose the attachment sandbox before enabling",
  });
export type AttachmentLimits = z.infer<typeof attachmentLimitsSchema>;
export type AttachmentHandling = z.infer<typeof attachmentHandlingSchema>;
export const attachmentProtocol = "io.bubblepilot/attachments";
export const attachmentProtocolVersion = 1;
export const attachmentPageSize = 20;
export const attachmentReferenceLimit = 100;
export interface AttachmentListing {
  messageId: string;
  entries: Array<{
    index: number;
    fileName: string | null;
    fileNameTruncated?: boolean;
    mimeType: string | null;
    sizeBytes: number | null;
    availability: "not-verified";
    attachment_ref?: string;
    matched?: boolean;
  }>;
  total: number;
  omitted: number;
  nextOffset: number | null;
  referenceLimitReached?: boolean;
}
export class AttachmentError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
