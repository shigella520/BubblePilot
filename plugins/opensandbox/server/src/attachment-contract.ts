import { z } from "zod";
export const attachmentProtocol = "io.bubblepilot/attachments";
export const transferSchema = z
  .object({
    id: z.string().uuid(),
    filename: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^/\\]+$/u)
      .refine((v) =>
        [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
      )
      .refine((v) => v !== "." && v !== ".."),
    size: z
      .number()
      .int()
      .min(1)
      .max(20 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    limits: z
      .object({
        files: z.number().int().min(1).max(5),
        totalMiB: z.number().int().min(1).max(50),
        expandedMiB: z.number().int().min(1).max(100),
        expandedFiles: z.number().int().min(1).max(500),
      })
      .strict(),
  })
  .strict();
export type TransferInput = z.infer<typeof transferSchema>;
export interface TransferResult {
  status: "imported";
  sandbox_path: string;
  size: number;
  sha256: string;
  expandedBytes: number;
  expandedFiles: number;
  expandedPath?: string;
}

export class TransferFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
export const transferFailureReasons = new Set([
  "unauthorized",
  "invalid_length",
  "incomplete_body",
  "hash_mismatch",
  "archive_path_denied",
  "archive_type_denied",
  "archive_file_limit",
  "archive_byte_limit",
  "xlsx_invalid_or_macros",
  "staging_changed",
  "directory_changed",
  "file_import_failed",
]);
