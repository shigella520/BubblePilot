import type { AttachmentListing } from "../attachments/attachment-policy.js";
import { executionPolicy } from "../ai/execution-policy.js";
import { z } from "zod";
import {
  embeddingConfigSchema,
  type EmbeddingConfig,
} from "./embedding-client.js";
export const memorySettingsSchema = embeddingConfigSchema.extend({
  enabled: z.boolean(),
  expectedVersion: z.number().int().min(0),
  secret: z.string().max(8192).optional(),
});
export const memorySearchValidationRules = [
  "Use either senderId or botWorkflowId, not both.",
  "from must be no later than to.",
] as const;
export const memorySearchSchema = z
  .object({
    botWorkflowId: z.string().uuid().optional(),
    query: z.string().trim().min(1).max(500),
    limit: z
      .number()
      .int()
      .min(1)
      .max(executionPolicy.search.maxLimit)
      .optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    senderId: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .refine((v) => !(v.senderId && v.botWorkflowId), {
    message: memorySearchValidationRules[0],
  })
  .refine((v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to), {
    message: memorySearchValidationRules[1],
  });
export const chatExcerptSchema = z
  .object({
    ref: z.string().min(1),
    attachmentOffset: z.number().int().min(0).max(10000).default(0),
    before: z
      .number()
      .int()
      .min(0)
      .max(executionPolicy.excerpt.maxSurrounding)
      .default(executionPolicy.excerpt.surrounding),
    after: z
      .number()
      .int()
      .min(0)
      .max(executionPolicy.excerpt.maxSurrounding)
      .default(executionPolicy.excerpt.surrounding),
  })
  .strict();
export type MemorySearch = z.infer<typeof memorySearchSchema>;
export interface Generation {
  id: string;
  config: EmbeddingConfig;
  encrypted_secret: string | null;
  identity: string;
  status: string;
}
export interface MemoryScope {
  timeZone?: string;
  chatId: string;
  upperIndex: number;
  sentTimeBoundary?: boolean;
  executionId: string | null;
  generation: Generation;
}
/**
 * Model-facing source item. `text` holds the XML message projections (id,
 * sender_id, chat-local sent_at, author, body); identity names are emitted once
 * per tool result as `participants` rather than repeated per item.
 */
export interface Evidence {
  attachments?: AttachmentListing[];
  images?: { image_ref: string; messageId: string; attachmentIndex: number }[];
  ref: string;
  text: string;
}
export interface MemoryCoverage {
  failed?: number;
  total: number;
  indexed: number;
  pending: number;
}
export interface MemorySearchResult {
  returnedCount?: number;
  candidateLimitReached?: boolean;
  selectionLimited?: boolean;
  exhaustive?: false;
  status: "succeeded" | "no-results" | "partial" | "unavailable";
  reason?: string;
  guidance?: string;
  warnings?: {
    component: "semantic" | "keyword";
    code: string;
    httpStatus?: number;
    guidance: string;
  }[];
  retrievalMode: "hybrid" | "keyword-only";
  /** sender_id -> display name for the returned evidence. */
  participants?: Record<string, string>;
  evidence: Evidence[];
  coverage: MemoryCoverage;
  retrievalId: string;
  truncated: boolean;
}
export const defaultMemoryConfig: EmbeddingConfig = {
  protocol: "ollama",
  baseUrl: "http://localhost:11434",
  model: "qwen3-embedding:0.6b",
  dimensions: 1024,
  modelVersion: "1",
  queryPrefix:
    "Instruct: Retrieve historical chat passages relevant to the user's question.\nQuery: ",
};
