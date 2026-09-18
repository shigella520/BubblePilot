import { it, expect, vi, afterEach } from "vitest";
import {
  submitMemeBatch,
  reconcileMemeBatch,
} from "../apps/web/src/services/meme-batch.js";
afterEach(() => vi.unstubAllGlobals());
it("reconciles a lost response without resending mutations", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { collectionId: "target", version: 2, enabled: true },
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { collectionId: null, version: 2, enabled: true },
        }),
      ),
    )
    .mockRejectedValueOnce(new Error("offline"));
  vi.stubGlobal("fetch", fetch);
  expect(
    await submitMemeBatch(
      [
        { id: "a", expectedVersion: 1 },
        { id: "b", expectedVersion: 1 },
        { id: "c", expectedVersion: 1 },
      ],
      { type: "move", collectionId: "target" },
    ),
  ).toEqual([
    { id: "a", status: "succeeded", version: 2 },
    { id: "b", status: "conflict", version: 2 },
    { id: "c", status: "unknown" },
  ]);
  expect(
    fetch.mock.calls.filter(
      (args) => (args[1] as RequestInit)?.method === "POST",
    ),
  ).toHaveLength(1);
});
it("treats confirmed absence as completed deletion but never treats a read failure as deletion", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 404 }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 })),
  );
  expect(
    await reconcileMemeBatch(
      [
        { id: "a", expectedVersion: 1 },
        { id: "b", expectedVersion: 1 },
      ],
      { type: "delete" },
    ),
  ).toEqual([
    { id: "a", status: "succeeded" },
    { id: "b", status: "unknown" },
  ]);
});
