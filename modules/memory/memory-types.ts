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
export const memorySearchSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    senderId: z.string().max(255).optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to));
export const latestChatMessagesSchema = z
  .object({
    senderId: z.string().trim().min(1).max(255).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(20).default(1),
  })
  .strict()
  .refine((v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to));
export type LatestChatMessages = z.infer<typeof latestChatMessagesSchema>;
export type MemorySearch = z.infer<typeof memorySearchSchema>;
export interface Generation {
  id: string;
  config: EmbeddingConfig;
  encrypted_secret: string | null;
  identity: string;
  status: string;
}
export interface MemoryScope {
  chatId: string;
  upperIndex: number;
  executionId: string | null;
  generation: Generation;
}
export interface Evidence {
  ref: string;
  text: string;
  messageIds: string[];
  dates: string[];
  senderIds: string[];
  participants: { senderId: string; name: string }[];
}
export interface MemoryCoverage {
  failed?: number;
  total: number;
  indexed: number;
  pending: number;
}
export interface MemorySearchResult {
  status: "succeeded" | "no-results" | "partial" | "unavailable";
  retrievalMode: "hybrid" | "keyword-only";
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
