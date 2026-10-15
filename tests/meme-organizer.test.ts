import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { organizeMemeLibrary } from "../modules/memes/organize-meme-library.js";
it("previews without writes, checks hashes, preserves existing groups, and reruns safely", async () => {
  const target = randomUUID(),
    other = randomUUID(),
    ids = Array.from({ length: 4 }, () => randomUUID()),
    hash = "a".repeat(64);
  let exists = false;
  const writes: string[] = [];
  const assets = new Map<
    string,
    { id: string; version: number; hash: string; collectionId: string | null }
  >(
    ids.map((id, i) => [
      id,
      {
        id,
        version: 1,
        hash: i === 2 ? "b".repeat(64) : hash,
        collectionId: i === 1 ? other : null,
      },
    ]),
  );
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    await Promise.resolve();
    if (init?.method) writes.push(path);
    if (path === "/api/v1/meme-collections") {
      if (init?.method === "POST") {
        exists = true;
        return { id: target, name: "虚构合集" } as T;
      }
      return { items: exists ? [{ id: target, name: "虚构合集" }] : [] } as T;
    }
    if (path === "/api/v1/memes/batch") {
      const body = JSON.parse(init!.body as string) as {
        items: { id: string }[];
      };
      for (const item of body.items) assets.get(item.id)!.collectionId = target;
      return {
        items: body.items.map((i) => ({ id: i.id, status: "succeeded" })),
      } as T;
    }
    const a = assets.get(path.split("/").at(-1)!);
    if (!a) throw Object.assign(new Error("missing"), { status: 404 });
    return a as T;
  };
  const manifest = ids.map((id) => ({ id, sha256: hash, ok: true }));
  const input = { manifest, name: "虚构合集", apply: false };
  expect((await organizeMemeLibrary(input, api)).map((r) => r.status)).toEqual([
    "ready",
    "conflict",
    "conflict",
    "ready",
  ]);
  expect(writes).toHaveLength(0);
  expect(
    (await organizeMemeLibrary({ ...input, apply: true }, api)).map(
      (r) => r.status,
    ),
  ).toEqual(["moved", "conflict", "conflict", "moved"]);
  const count = writes.length;
  expect(
    (await organizeMemeLibrary({ ...input, apply: true }, api)).map(
      (r) => r.status,
    ),
  ).toEqual(["already-grouped", "conflict", "conflict", "already-grouped"]);
  expect(writes).toHaveLength(count);
});
