import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { memeLimits } from "./meme-types.js";
export interface MemeFileStore {
  put(bytes: Buffer): Promise<{
    storageKey: string;
    hash: string;
    mimeType: string;
    size: number;
    width: number;
    height: number;
  }>;
  read(key: string, preview?: boolean): Promise<Buffer>;
  remove(key: string): Promise<void>;
  collectOrphans(liveKeys: readonly string[]): Promise<number>;
}
export class LocalMemeFileStore implements MemeFileStore {
  constructor(private readonly root: string) {}
  private path(key: string) {
    if (!/^[0-9a-f-]{36}$/u.test(key))
      throw new Error("MEME_INVALID_STORAGE_KEY");
    return join(this.root, key);
  }
  async put(bytes: Buffer) {
    if (!bytes.length || bytes.length > memeLimits.fileBytes)
      throw new Error("MEME_FILE_SIZE_INVALID");
    const signature = bytes.subarray(0, 12);
    if (!(
      signature.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
      signature
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      ["GIF87a", "GIF89a"].includes(
        signature.subarray(0, 6).toString("ascii"),
      ) ||
      (signature.subarray(0, 4).toString("ascii") === "RIFF" &&
        signature.subarray(8, 12).toString("ascii") === "WEBP")
    ))
      throw new Error("MEME_FORMAT_UNSUPPORTED");
    const image = sharp(bytes, {
      limitInputPixels: memeLimits.pixels,
      pages: 1,
      failOn: "warning",
    }).timeout({ seconds: memeLimits.decodeSeconds });
    const metadata = await image.metadata();
    const mime = {
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
    }[metadata.format as string];
    if (
      !mime ||
      !metadata.width ||
      !metadata.height ||
      (metadata.format !== "gif" && (metadata.pages ?? 1) > 1)
    )
      throw new Error("MEME_FORMAT_UNSUPPORTED");
    if (
      metadata.width * (metadata.pageHeight ?? metadata.height) >
      memeLimits.pixels
    )
      throw new Error("MEME_PIXELS_EXCEEDED");
    const preview = await image
      .resize(memeLimits.thumbnailSize, memeLimits.thumbnailSize, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    const storageKey = randomUUID();
    const directory = this.path(storageKey);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(directory, "original"), bytes, { mode: 0o600 });
      await writeFile(join(directory, "preview.png"), preview, { mode: 0o600 });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return {
      storageKey,
      hash: createHash("sha256").update(bytes).digest("hex"),
      mimeType: mime,
      size: bytes.length,
      width: metadata.width,
      height: metadata.pageHeight ?? metadata.height,
    };
  }
  read(key: string, preview = false) {
    return readFile(join(this.path(key), preview ? "preview.png" : "original"));
  }
  remove(key: string) {
    return rm(this.path(key), { recursive: true, force: true });
  }
  async collectOrphans(liveKeys: readonly string[]) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const live = new Set(liveKeys);
    let count = 0;
    for (const key of await readdir(this.root)) {
      if (!/^[0-9a-f-]{36}$/u.test(key) || live.has(key)) continue;
      const info = await stat(this.path(key));
      if (Date.now() - info.mtimeMs < 24 * 60 * 60 * 1000) continue;
      await this.remove(key);
      count++;
    }
    return count;
  }
}
