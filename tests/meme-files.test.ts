import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { LocalMemeFileStore } from "../modules/memes/file-store.js";
import { memeLimits } from "../modules/memes/meme-types.js";
const paths: string[] = [];
async function store() {
  const path = await mkdtemp(join(tmpdir(), "meme-test-"));
  paths.push(path);
  return new LocalMemeFileStore(path);
}
afterEach(async () => {
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});
describe("meme file protection", () => {
  it("stores immutable original with a decoded static preview", async () => {
    const files = await store();
    const data = await sharp({
      create: { width: 12, height: 9, channels: 3, background: "#abc" },
    })
      .png()
      .toBuffer();
    const saved = await files.put(data);
    expect(saved).toMatchObject({
      mimeType: "image/png",
      width: 12,
      height: 9,
      size: data.length,
    });
    expect(await files.read(saved.storageKey)).toEqual(data);
    expect(
      (await sharp(await files.read(saved.storageKey, true)).metadata()).format,
    ).toBe("png");
  });
  it("rejects SVG, corrupt images, excess bytes and path traversal", async () => {
    const files = await store();
    await expect(
      files.put(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
        ),
      ),
    ).rejects.toThrow();
    await expect(files.put(Buffer.from("GIF89a broken"))).rejects.toThrow();
    await expect(
      files.put(Buffer.alloc(memeLimits.fileBytes + 1)),
    ).rejects.toThrow("MEME_FILE_SIZE_INVALID");
    expect(() => files.read("../../secret")).toThrow();
  });
  it("uses random keys but stable hash for duplicate bytes", async () => {
    const files = await store();
    const data = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    })
      .gif()
      .toBuffer();
    const a = await files.put(data),
      b = await files.put(data);
    expect(a.hash).toBe(b.hash);
    expect(a.storageKey).not.toBe(b.storageKey);
    expect(
      (await sharp(await files.read(a.storageKey, true)).metadata()).pages ?? 1,
    ).toBe(1);
  });
});
