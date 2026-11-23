import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { normalizeImageInput } from "../modules/ai/image-input-processing.js";
import { exifImage, tileValues } from "./support/exif-image.js";

describe("EXIF image input normalization", () => {
  it.each([
    [1, [20, 60, 100, 140, 180, 220]],
    [2, [100, 60, 20, 220, 180, 140]],
    [3, [220, 180, 140, 100, 60, 20]],
    [4, [140, 180, 220, 20, 60, 100]],
    [5, [20, 140, 60, 180, 100, 220]],
    [6, [140, 20, 180, 60, 220, 100]],
    [7, [220, 100, 180, 60, 140, 20]],
    [8, [100, 220, 60, 180, 20, 140]],
  ] as const)(
    "bakes orientation %i into pixels and removes the tag",
    async (orientation, expected) => {
      const input = await exifImage(orientation);
      const output = await normalizeImageInput(input, 100_000);
      expect(await tileValues(output.body)).toEqual(expected);
      expect([output.width, output.height]).toEqual(
        orientation >= 5 ? [40, 60] : [60, 40],
      );
      const metadata = await sharp(output.body).metadata();
      expect(metadata.orientation).toBeUndefined();
      expect(metadata.exif).toBeUndefined();
      expect((await normalizeImageInput(output.body, 100_000)).body).toEqual(
        output.body,
      );
    },
  );

  it.each(["jpeg", "webp"] as const)(
    "preserves %s format and corrects a half-turn",
    async (format) => {
      const output = await normalizeImageInput(
        await exifImage(3, format),
        100_000,
      );
      expect(output.mimeType).toBe(`image/${format}`);
      expect((await sharp(output.body).metadata()).orientation).toBeUndefined();
      const pixels = await tileValues(output.body);
      for (const [i, value] of [220, 180, 140, 100, 60, 20].entries())
        expect(Math.abs(pixels[i]! - value)).toBeLessThanOrEqual(3);
    },
  );

  it("keeps an untagged animation and legacy diagnostics byte-for-byte", async () => {
    const gif = await sharp(
      Buffer.concat([Buffer.alloc(12, 20), Buffer.alloc(12, 220)]),
      {
        raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
      },
    )
      .gif({ delay: [100, 100] })
      .toBuffer();
    expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(2);
    expect((await normalizeImageInput(gif, 100_000)).body).toEqual(gif);
    const old = await exifImage(6);
    expect(
      (
        await normalizeImageInput(
          old,
          100_000,
          "bluebubbles-compatible-original-false",
        )
      ).body,
    ).toEqual(old);
  });

  it("rejects invalid content, input/output oversize and cancellation", async () => {
    await expect(
      normalizeImageInput(Buffer.from("not an image"), 1000),
    ).rejects.toMatchObject({ code: "AI_IMAGE_INVALID_CONTENT" });
    const input = await exifImage(3);
    await expect(
      normalizeImageInput(input, input.length - 1),
    ).rejects.toMatchObject({ code: "AI_IMAGE_TOO_LARGE" });
    // Low-quality compressed noise expands when normalized to legible JPEG.
    const noise = Buffer.from(
      Array.from({ length: 90_000 }, (_, i) => (i * 71 + (i >> 4) * 31) % 256),
    );
    const jpeg = await sharp(noise, {
      raw: { width: 200, height: 150, channels: 3 },
    })
      .jpeg({ quality: 10 })
      .withMetadata({ orientation: 3 })
      .toBuffer();
    expect(
      (await normalizeImageInput(jpeg, 1_000_000)).body.length,
    ).toBeGreaterThan(jpeg.length);
    await expect(normalizeImageInput(jpeg, jpeg.length)).rejects.toMatchObject({
      code: "AI_IMAGE_TOO_LARGE",
    });
    await expect(
      normalizeImageInput(input, 100_000, undefined, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
