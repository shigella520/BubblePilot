import { ApiError, apiRequest } from "./api.js";
export interface SelectionItem {
  id: string;
  expectedVersion: number;
}
export type BatchAction =
  | { type: "move"; collectionId: string | null }
  | { type: "enable"; enabled: boolean }
  | { type: "delete" };
export interface BatchResult {
  id: string;
  status: "succeeded" | "conflict" | "missing" | "unknown";
  version?: number;
}
export async function reconcileMemeBatch(
  items: SelectionItem[],
  action: BatchAction,
): Promise<BatchResult[]> {
  const out: BatchResult[] = [];
  for (const item of items) {
    try {
      const asset = await apiRequest<{
        version: number;
        enabled: boolean;
        collectionId: string | null;
      }>(`/api/v1/memes/${item.id}`, { signal: AbortSignal.timeout(10000) });
      const reached =
        action.type === "move"
          ? asset.collectionId === action.collectionId
          : action.type === "enable"
            ? asset.enabled === action.enabled
            : false;
      out.push({
        id: item.id,
        status: reached ? "succeeded" : "conflict",
        version: asset.version,
      });
    } catch (e) {
      out.push({
        id: item.id,
        status:
          e instanceof ApiError && e.status === 404
            ? action.type === "delete"
              ? "succeeded"
              : "missing"
            : "unknown",
      });
    }
  }
  return out;
}
export async function submitMemeBatch(
  items: SelectionItem[],
  action: BatchAction,
): Promise<BatchResult[]> {
  try {
    return (
      await apiRequest<{ items: BatchResult[] }>("/api/v1/memes/batch", {
        signal: AbortSignal.timeout(30000),
        method: "POST",
        body: JSON.stringify({ items, action }),
      })
    ).items;
  } catch {
    return reconcileMemeBatch(items, action);
  }
}
