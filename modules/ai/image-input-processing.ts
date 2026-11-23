import sharp from "sharp";
import type { ImageInputDiagnostic } from "./ai-types.js";
import { executionPolicy } from "./execution-policy.js";

export const imageInputProcessingVersion =
  "bluebubbles-compatible-exif-v2" as const;

export class ImageInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function imageMime(body: Buffer): string | null {
  if (
    body.length >= 3 &&
    body[0] === 0xff &&
    body[1] === 0xd8 &&
    body[2] === 0xff
  )
    return "image/jpeg";
  if (
    body.length >= 8 &&
    body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    body.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(body.subarray(0, 6).toString("ascii"))
  )
    return "image/gif";
  if (
    body.length >= 12 &&
    body.subarray(0, 4).toString("ascii") === "RIFF" &&
    body.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return null;
}

/** Normalize only tagged images; leave untagged bytes (including animations) intact. */
export async function normalizeImageInput(
  body: Buffer,
  maximumBytes: number,
  version: ImageInputDiagnostic["processingVersion"] = imageInputProcessingVersion,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (body.length > maximumBytes)
    throw new ImageInputError("AI_IMAGE_TOO_LARGE");
  const mimeType = imageMime(body);
  if (!mimeType) throw new ImageInputError("AI_IMAGE_INVALID_CONTENT");
  const image = sharp(body, {
    limitInputPixels: executionPolicy.image.maxInputPixels,
    animated: false,
  });
  let metadata;
  try {
    metadata = await image.metadata();
  } catch {
    throw new ImageInputError("AI_IMAGE_INVALID_CONTENT");
  }
  signal?.throwIfAborted();
  if (
    version === "bluebubbles-compatible-original-false" ||
    metadata.orientation === undefined
  )
    return {
      body,
      mimeType,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
    };
  // Do not silently flatten a tagged animation while correcting its first frame.
  if ((metadata.pages ?? 1) > 1)
    throw new ImageInputError("AI_IMAGE_ORIENTATION_UNSUPPORTED");
  let normalized;
  try {
    // autoOrient handles all eight EXIF orientations, including mirrored axes.
    // Sharp's default output strips metadata, so no stale direction can be applied twice.
    image.autoOrient();
    if (mimeType === "image/jpeg")
      image.jpeg({ quality: 95, chromaSubsampling: "4:4:4" });
    else if (mimeType === "image/webp") image.webp({ lossless: true });
    normalized = await image.toBuffer({ resolveWithObject: true });
  } catch {
    throw new ImageInputError("AI_IMAGE_ORIENTATION_FAILED");
  }
  signal?.throwIfAborted();
  if (normalized.data.length > maximumBytes)
    throw new ImageInputError("AI_IMAGE_TOO_LARGE");
  return {
    body: normalized.data,
    mimeType,
    width: normalized.info.width,
    height: normalized.info.height,
  };
}
