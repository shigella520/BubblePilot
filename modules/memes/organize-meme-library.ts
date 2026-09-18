import { z } from "zod";
import type { MemeAsset } from "./meme-types.js";
import type {
  MemeCollection,
  MemeBatchResult,
} from "./meme-collection-types.js";
export const importManifestSchema = z
  .array(
    z.object({
      id: z.string().uuid(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/i),
      ok: z.literal(true),
    }),
  )
  .min(1)
  .max(5000)
  .refine(
    (rows) => new Set(rows.map((r) => r.id)).size === rows.length,
    "重复素材 ID",
  );
export type OrganizerResult = {
  id: string;
  status:
    "ready" | "moved" | "already-grouped" | "conflict" | "missing" | "unknown";
};
export async function organizeMemeLibrary(
  input: { manifest: unknown; name: string; apply: boolean },
  api: <T>(path: string, init?: RequestInit) => Promise<T>,
): Promise<OrganizerResult[]> {
  const rows = importManifestSchema.parse(input.manifest);
  let target = (
    await api<{ items: MemeCollection[] }>("/api/v1/meme-collections")
  ).items.find((c) => c.name.toLowerCase() === input.name.trim().toLowerCase());
  const results: OrganizerResult[] = [],
    pending: { id: string; expectedVersion: number }[] = [];
  for (const row of rows) {
    let asset: MemeAsset | null;
    try {
      asset = await api<MemeAsset>("/api/v1/memes/" + row.id);
    } catch (e) {
      if ((e as { status?: number }).status === 404) {
        results.push({ id: row.id, status: "missing" });
        continue;
      }
      throw e;
    }
    if (asset.hash.toLowerCase() !== row.sha256.toLowerCase()) {
      results.push({ id: row.id, status: "conflict" });
      continue;
    }
    if (asset.collectionId) {
      results.push({
        id: row.id,
        status:
          asset.collectionId === target?.id ? "already-grouped" : "conflict",
      });
      continue;
    }
    pending.push({ id: row.id, expectedVersion: asset.version });
    results.push({ id: row.id, status: "ready" });
  }
  if (!input.apply || !pending.length) return results;
  if (!target) {
    try {
      target = await api<MemeCollection>("/api/v1/meme-collections", {
        method: "POST",
        body: JSON.stringify({ name: input.name.trim(), description: "" }),
      });
    } catch (e) {
      target = (
        await api<{ items: MemeCollection[] }>("/api/v1/meme-collections")
      ).items.find(
        (c) => c.name.toLowerCase() === input.name.trim().toLowerCase(),
      );
      if (!target) throw e;
    }
  }
  for (let offset = 0; offset < pending.length; offset += 100) {
    const items = pending.slice(offset, offset + 100);
    let batch: MemeBatchResult[];
    try {
      batch = (
        await api<{ items: MemeBatchResult[] }>("/api/v1/memes/batch", {
          method: "POST",
          body: JSON.stringify({
            items,
            action: { type: "move", collectionId: target.id },
          }),
        })
      ).items;
    } catch {
      for (const item of items) {
        const result = results.find((r) => r.id === item.id)!;
        try {
          const fresh = await api<MemeAsset>("/api/v1/memes/" + item.id);
          result.status =
            fresh.collectionId === target.id ? "moved" : "conflict";
        } catch {
          result.status = "unknown";
        }
      }
      break;
    }
    for (const r of batch)
      results.find((x) => x.id === r.id)!.status =
        r.status === "succeeded" ? "moved" : r.status;
  }
  return results;
}
