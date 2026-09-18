import type {
  MemeCollectionRepository,
  MemeFilter,
} from "./meme-collection-types.js";
import { z } from "zod";
export const memeLimits = Object.freeze({
  fileBytes: 10 * 1024 * 1024,
  pixels: 20_000_000,
  decodeSeconds: 5,
  thumbnailSize: 512,
  searchDefault: 5,
  searchMax: 10,
  summaryAttempts: 3,
  leaseMs: 600_000,
});
export const memeMetadataSchema = z.object({
  collectionId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});
export const memeEditSchema = memeMetadataSchema.extend({
  expectedVersion: z.number().int().positive(),
  summary: z.string().max(2400).optional(),
  enabled: z.boolean().optional(),
});
export type MemeMetadata = z.infer<typeof memeMetadataSchema>;
export interface MemeAsset extends MemeMetadata {
  collectionName?: string | null;
  summaryInputVersion?: number;
  id: string;
  summary: string | null;
  summaryManual: boolean;
  candidateSummary: string | null;
  summaryStatus: "pending" | "processing" | "succeeded" | "failed";
  summaryError: string | null;
  enabled: boolean;
  mimeType: string;
  size: number;
  width: number;
  height: number;
  hash: string;
  storageKey: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface SelectedMeme {
  id: string;
  name: string;
  hash: string;
}
export interface MemeSummaryJob {
  id: string;
  memeId: string;
  owner: string;
  attempt: number;
  baseVersion: number;
  inputVersion?: number | null;
  candidate: boolean;
}
export interface MemeRepository extends MemeCollectionRepository {
  list(
    input: MemeFilter & {
      offset: number;
      limit: number;
    },
  ): Promise<{ items: MemeAsset[]; total: number }>;
  get(id: string): Promise<MemeAsset | null>;
  create(
    input: MemeMetadata &
      Pick<
        MemeAsset,
        "mimeType" | "size" | "width" | "height" | "hash" | "storageKey"
      >,
  ): Promise<{ asset: MemeAsset; created: boolean }>;
  edit(
    id: string,
    input: z.infer<typeof memeEditSchema>,
  ): Promise<MemeAsset | null>;
  remove(id: string, version: number): Promise<boolean>;
  enqueue(id: string, version: number, candidate: boolean): Promise<boolean>;
  adopt(id: string, version: number): Promise<MemeAsset | null>;
  claim(owner: string): Promise<MemeSummaryJob | null>;
  complete(job: MemeSummaryJob, summary: string): Promise<boolean>;
  fail(job: MemeSummaryJob, code: string): Promise<void>;
  search(query: string, limit: number): Promise<MemeAsset[]>;
  storageKeys(): Promise<string[]>;
  close(): Promise<void>;
}
