import { z } from "zod";
export const collectionLimits = { selection: 5000, batch: 100 } as const;
export const collectionSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((n) => !["全部表情", "未分类"].includes(n), "保留名称不可使用"),
  description: z.string().trim().max(2000).default(""),
  coverMemeId: z.string().uuid().nullable().optional(),
});
export const memeFilterSchema = z.object({
  query: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
  status: z.enum(["pending", "processing", "succeeded", "failed"]).optional(),
  collection: z
    .union([z.literal("all"), z.literal("unclassified"), z.string().uuid()])
    .default("all"),
});
export type MemeFilter = z.input<typeof memeFilterSchema>;
export const selectionItemSchema = z.object({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});
export type MemeSelectionItem = z.infer<typeof selectionItemSchema>;
export const batchActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("move"),
    collectionId: z.string().uuid().nullable(),
  }),
  z.object({ type: z.literal("enable"), enabled: z.boolean() }),
  z.object({ type: z.literal("delete") }),
]);
export type MemeBatchAction = z.infer<typeof batchActionSchema>;
export const memeBatchSchema = z.object({
  items: z
    .array(selectionItemSchema)
    .min(1)
    .max(collectionLimits.batch)
    .refine(
      (items) => new Set(items.map((i) => i.id)).size === items.length,
      "重复素材 ID",
    ),
  action: batchActionSchema,
});
export interface MemeBatchResult {
  id: string;
  status: "succeeded" | "conflict" | "missing";
  version?: number;
}
export interface MemeCollection {
  id: string;
  name: string;
  description: string;
  coverMemeId: string | null;
  effectiveCoverMemeId: string | null;
  count: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface MemeCollectionRepository {
  listCollections(): Promise<{
    items: MemeCollection[];
    total: number;
    unclassified: number;
  }>;
  createCollection(
    input: z.infer<typeof collectionSchema>,
  ): Promise<MemeCollection>;
  editCollection(
    id: string,
    input: z.infer<typeof collectionSchema> & { expectedVersion: number },
  ): Promise<MemeCollection | null>;
  removeCollection(id: string, version: number): Promise<boolean>;
  selection(input: MemeFilter): Promise<MemeSelectionItem[]>;
  batch(input: z.infer<typeof memeBatchSchema>): Promise<MemeBatchResult[]>;
}
