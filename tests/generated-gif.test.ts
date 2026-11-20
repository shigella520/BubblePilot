import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import sharp from "sharp";
import { validateReplyFile } from "../modules/generated-images/file-validation.js";
import {
  generatedImageLimits,
  generatedGifLimits,
} from "../modules/generated-images/image-policy.js";
import { animatedGif } from "./support/animated-gif.js";
const signal = () => new AbortController().signal;

it("accepts static and animated GIFs with canvas dimensions and unchanged frame metadata", async () => {
  for (const frames of [1, 2]) {
    const gif = await animatedGif(frames);
    const original = Buffer.from(gif);
    const info = await validateReplyFile(
      gif,
      "示例动画.GIF",
      ["gif"],
      signal(),
    );
    expect(info).toMatchObject({
      filename: "示例动画.GIF",
      mimeType: "image/gif",
      fileType: "gif",
      width: 8,
      height: 6,
      size: gif.length,
      sha256: createHash("sha256").update(original).digest("hex"),
    });
    expect(gif).toEqual(original);
    const metadata = await sharp(gif, { animated: true }).metadata();
    expect(metadata.pages).toBe(frames);
    if (frames === 2)
      expect(metadata).toMatchObject({
        delay: [80, 120],
        loop: 0,
        hasAlpha: true,
      });
  }
});

it("requires GIF authorization and rejects renamed formats and damaged later frames", async () => {
  const gif = await animatedGif();
  await expect(
    validateReplyFile(gif, "a.gif", ["png"], signal()),
  ).rejects.toThrow("FILE_TYPE_NOT_AUTHORIZED");
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await expect(
    validateReplyFile(png, "a.gif", ["gif"], signal()),
  ).rejects.toThrow("FILE_TYPE_MISMATCH");
  await expect(
    validateReplyFile(gif, "a.png", ["png"], signal()),
  ).rejects.toThrow("IMAGE_INVALID");
  for (const invalid of [
    gif.subarray(0, -1),
    Buffer.concat([gif.subarray(0, -8), Buffer.from([0x3b])]),
  ])
    await expect(
      validateReplyFile(invalid, "broken.gif", ["gif"], signal()),
    ).rejects.toThrow("IMAGE_INVALID");
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    validateReplyFile(gif, "a.gif", ["gif"], aborted.signal),
  ).rejects.toThrow();
});

it("bounds GIF byte size, frame count, canvas edges and cumulative decoded pixels", async () => {
  await expect(
    validateReplyFile(
      Buffer.alloc(generatedImageLimits.bytes + 1),
      "big.gif",
      ["gif"],
      signal(),
    ),
  ).rejects.toThrow("IMAGE_TOO_LARGE");
  const boundary = await animatedGif(generatedGifLimits.frames, 1, 1);
  await expect(
    validateReplyFile(boundary, "boundary.gif", ["gif"], signal()),
  ).resolves.toMatchObject({ width: 1, height: 1 });
  const many = await animatedGif(generatedGifLimits.frames + 1, 1, 1);
  await expect(
    validateReplyFile(many, "frames.gif", ["gif"], signal()),
  ).rejects.toThrow("IMAGE_ANIMATION_LIMIT");
  const edge = await animatedGif(1, 1, 1);
  edge.writeUInt16LE(generatedImageLimits.edge + 1, 6);
  await expect(
    validateReplyFile(edge, "edge.gif", ["gif"], signal()),
  ).rejects.toThrow("IMAGE_PIXELS_EXCEEDED");
  // Tiny local frames on a large logical canvas: the decoded/composited size still counts.
  const total = await animatedGif(5, 1, 1);
  total.writeUInt16LE(4000, 6);
  total.writeUInt16LE(4000, 8);
  await expect(
    validateReplyFile(total, "total.gif", ["gif"], signal()),
  ).rejects.toThrow("IMAGE_ANIMATION_LIMIT");
});
