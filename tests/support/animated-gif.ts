import sharp from "sharp";

/** Fictional two-colour animation, generated locally without external assets. */
export async function animatedGif(frames = 2, width = 8, height = 6) {
  const pixels = Buffer.alloc(width * height * frames * 4);
  for (let frame = 0; frame < frames; frame++)
    for (let pixel = 0; pixel < width * height; pixel++) {
      const offset = (frame * width * height + pixel) * 4;
      pixels[offset] = frame % 2 === 0 ? 255 : 0;
      pixels[offset + 2] = frame % 2 === 0 ? 0 : 255;
      pixels[offset + 3] = pixel === 0 && width * height > 1 ? 0 : 255;
    }
  return sharp(pixels, {
    raw: { width, height: height * frames, pageHeight: height, channels: 4 },
  })
    .gif({
      delay: Array.from({ length: frames }, (_, i) => (i % 2 ? 120 : 80)),
      loop: 0,
    })
    .toBuffer();
}
