import sharp from "sharp";
import {
  GeneratedImageError,
  generatedImageLimits,
  generatedGifLimits,
} from "./image-policy.js";

// Check the container before decoding: some decoders silently accept truncated frames
// or ignore an oversized logical canvas when only a small subrectangle is drawn.
function gifContainer(bytes: Buffer) {
  let offset = 13;
  const invalid = () => new GeneratedImageError("IMAGE_INVALID");
  const skip = (length: number) => {
    if (offset + length > bytes.length) throw invalid();
    offset += length;
  };
  const blocks = () => {
    for (;;) {
      if (offset >= bytes.length) throw invalid();
      const length = bytes[offset++]!;
      if (!length) return;
      skip(length);
    }
  };
  if (bytes.length < 14) throw invalid();
  const width = bytes.readUInt16LE(6),
    height = bytes.readUInt16LE(8);
  if (!width || !height) throw invalid();
  if (
    Math.max(width, height) > generatedImageLimits.edge ||
    width * height > generatedImageLimits.pixels
  )
    throw new GeneratedImageError("IMAGE_PIXELS_EXCEEDED");
  if (bytes[10]! & 0x80) skip(3 * 2 ** ((bytes[10]! & 7) + 1));
  let frames = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++]!;
    if (marker === 0x3b) {
      if (offset !== bytes.length || !frames) throw invalid();
      return { width, height, frames };
    }
    if (marker === 0x21) {
      skip(1);
      blocks();
      continue;
    }
    if (marker !== 0x2c) throw invalid();
    const descriptor = offset;
    skip(9);
    const left = bytes.readUInt16LE(descriptor),
      top = bytes.readUInt16LE(descriptor + 2);
    const frameWidth = bytes.readUInt16LE(descriptor + 4),
      frameHeight = bytes.readUInt16LE(descriptor + 6);
    if (
      !frameWidth ||
      !frameHeight ||
      left + frameWidth > width ||
      top + frameHeight > height
    )
      throw invalid();
    frames++;
    if (
      frames > generatedGifLimits.frames ||
      width * height * frames > generatedGifLimits.totalPixels
    )
      throw new GeneratedImageError("IMAGE_ANIMATION_LIMIT");
    const packed = bytes[descriptor + 8]!;
    if (packed & 0x80) skip(3 * 2 ** ((packed & 7) + 1));
    if (offset >= bytes.length || bytes[offset]! < 2 || bytes[offset]! > 8)
      throw invalid();
    skip(1);
    blocks();
  }
  throw invalid();
}

/** Validate every frame without re-encoding or flattening the delivered GIF. */
export async function validateGeneratedGif(bytes: Buffer, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > generatedImageLimits.bytes)
    throw new GeneratedImageError("IMAGE_TOO_LARGE");
  if (!["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)))
    throw new GeneratedImageError("FILE_TYPE_MISMATCH");
  const { width, height, frames } = gifContainer(bytes);
  try {
    const image = sharp(bytes, {
      animated: true,
      limitInputPixels: generatedGifLimits.totalPixels,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    if (metadata.format !== "gif" || (metadata.pages ?? 1) !== frames)
      throw new GeneratedImageError("IMAGE_INVALID");
    signal.throwIfAborted();
    // stats consumes all decoded pages without returning a potentially huge raw buffer.
    await image.timeout({ seconds: 5 }).stats();
    signal.throwIfAborted();
    return { width, height };
  } catch (error) {
    signal.throwIfAborted();
    throw error instanceof GeneratedImageError
      ? error
      : new GeneratedImageError("IMAGE_INVALID");
  }
}
