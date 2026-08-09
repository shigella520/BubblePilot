import { z } from "zod";

export const linkPreviewItemSchema = z.object({
  source: z.enum(["bluebubbles", "open-graph"]),
  url: z.string().url().max(2_048),
  originalUrl: z.string().url().max(2_048).nullable(),
  title: z.string().max(500).nullable(),
  summary: z.string().max(2_000).nullable(),
  siteName: z.string().max(200).nullable(),
  imageAvailable: z.boolean(),
  imageUrl: z.string().url().max(2_048).nullable().default(null),
  imageSource: z.enum(["bluebubbles", "open-graph"]).nullable().default(null),
  iconAvailable: z.boolean(),
});

export type LinkPreviewItem = z.infer<typeof linkPreviewItemSchema>;

export const linkPreviewStatusSchema = z.enum([
  "not-requested",
  "pending",
  "available",
  "unavailable",
  "failed",
  "redacted",
]);

export type LinkPreviewStatus = z.infer<typeof linkPreviewStatusSchema>;

export interface LinkPreviewBundle {
  status: LinkPreviewStatus;
  errorCode: string | null;
  items: readonly LinkPreviewItem[];
}

export interface LinkPreviewDiagnostic {
  source: "bluebubbles" | "open-graph";
  attempt: number;
  status: "succeeded" | "empty" | "failed";
  durationMs: number;
  httpStatus: number | null;
  code: string | null;
}

export const emptyLinkPreview = (
  status: LinkPreviewStatus = "not-requested",
  errorCode: string | null = null,
): LinkPreviewBundle => ({ status, errorCode, items: [] });
