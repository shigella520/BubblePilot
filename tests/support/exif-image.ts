import sharp from "sharp";

// Six asymmetric grayscale tiles, so rotations and mirrored axes are distinct.
export async function exifImage(
  orientation: number,
  format: "png" | "jpeg" | "webp" = "png",
) {
  const values = [20, 60, 100, 140, 180, 220];
  const pixels = Buffer.alloc(60 * 40 * 3);
  for (let y = 0; y < 40; y++)
    for (let x = 0; x < 60; x++)
      pixels.fill(
        values[Math.floor(y / 20) * 3 + Math.floor(x / 20)]!,
        (y * 60 + x) * 3,
        (y * 60 + x) * 3 + 3,
      );
  return sharp(pixels, { raw: { width: 60, height: 40, channels: 3 } })
    .withMetadata({ orientation })
    .toFormat(format)
    .toBuffer();
}

export async function tileValues(body: Buffer) {
  const { data, info } = await sharp(body)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const values: number[] = [];
  for (let y = 10; y < info.height; y += 20)
    for (let x = 10; x < info.width; x += 20)
      values.push(data[(y * info.width + x) * info.channels]!);
  return values;
}
