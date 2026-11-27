import sharp from "sharp";
import { ToolError } from "./errors.js";

/** Matches BubblePilot generatedImageLimits; exports beyond these are rejected by BP. */
export const exportLimits = {
  bytes: 8 * 1024 * 1024,
  pixels: 16_000_000,
  edge: 8192,
} as const;
/** Mirrors OpenSandbox view_image so BP's tool-image pipeline accepts results. */
export const previewLimits = {
  pixels: 40_000_000,
  edge: 2048,
  bytes: 512 * 1024,
} as const;

export const acceptedInputMimeTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export type InputMime = (typeof acceptedInputMimeTypes)[number];

/** Content sniffing only; declared MIME types and filenames are not trusted. */
export function sniffMime(data: Uint8Array): InputMime | null {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  )
    return "image/png";
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    return "image/jpeg";
  if (
    data.length >= 12 &&
    Buffer.from(data.subarray(0, 4)).toString("latin1") === "RIFF" &&
    Buffer.from(data.subarray(8, 12)).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return null;
}

export interface ImageInfo {
  mime: InputMime;
  width: number;
  height: number;
  animated: boolean;
}

/** Decode-check an image without trusting headers alone. */
export async function inspectImage(data: Buffer): Promise<ImageInfo> {
  const mime = sniffMime(data);
  if (!mime) throw new ToolError("input_type_unsupported");
  try {
    const meta = await sharp(data, {
      limitInputPixels: previewLimits.pixels,
      animated: true,
    }).metadata();
    const width = meta.width ?? 0;
    const height = meta.pageHeight ?? meta.height ?? 0;
    if (!width || !height) throw new Error("no dimensions");
    // Full decode proves the payload is not truncated or malformed.
    await sharp(data, { limitInputPixels: previewLimits.pixels })
      .raw()
      .toBuffer();
    return { mime, width, height, animated: (meta.pages ?? 1) > 1 };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("image_invalid");
  }
}

/**
 * Normalise an upstream result to a single-frame PNG within BP export limits.
 * Non-PNG results are converted; oversized PNGs are recompressed once.
 */
export async function normalizeOutput(data: Buffer): Promise<{
  png: Buffer;
  width: number;
  height: number;
}> {
  const info = await inspectImage(data);
  if (info.animated) throw new ToolError("image_animated");
  if (
    info.width > exportLimits.edge ||
    info.height > exportLimits.edge ||
    info.width * info.height > exportLimits.pixels
  )
    throw new ToolError("image_pixels_exceeded");
  let png =
    info.mime === "image/png"
      ? data
      : await sharp(data).png({ compressionLevel: 9 }).toBuffer();
  if (png.length > exportLimits.bytes)
    png = await sharp(png)
      .png({ compressionLevel: 9, palette: false })
      .toBuffer();
  if (png.length > exportLimits.bytes) throw new ToolError("image_too_large");
  return { png, width: info.width, height: info.height };
}

/** Validate a workspace file exactly like OpenSandbox's export helper does. */
export async function validateExportPng(data: Buffer) {
  if (data.length > exportLimits.bytes) throw new ToolError("image_too_large");
  const info = await inspectImage(data).catch((error: unknown) => {
    throw error instanceof ToolError &&
      error.message !== "input_type_unsupported"
      ? error
      : new ToolError("image_invalid");
  });
  if (info.mime !== "image/png") throw new ToolError("image_invalid");
  if (
    info.width * info.height > exportLimits.pixels ||
    Math.max(info.width, info.height) > exportLimits.edge
  )
    throw new ToolError("image_pixels_exceeded");
  if (info.animated) throw new ToolError("image_animated");
}

export interface Preview {
  data: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  sourceBytes: number;
  bytes: number;
  transformed: boolean;
  firstFrameOnly: boolean;
  whiteBackground: boolean;
}

/** Bounded static preview with the same metadata shape as OpenSandbox. */
export async function preview(data: Buffer): Promise<Preview> {
  const info = await inspectImage(data);
  const resized = sharp(data, { limitInputPixels: previewLimits.pixels })
    .rotate()
    .resize(previewLimits.edge, previewLimits.edge, {
      fit: "inside",
      withoutEnlargement: true,
    });
  let out = await resized.clone().png().toBuffer({ resolveWithObject: true });
  let mimeType: Preview["mimeType"] = "image/png";
  let whiteBackground = false;
  if (out.data.length > previewLimits.bytes) {
    whiteBackground = true;
    for (const quality of [90, 80, 70]) {
      out = await resized
        .clone()
        .flatten({ background: "#ffffff" })
        .jpeg({ quality })
        .toBuffer({ resolveWithObject: true });
      mimeType = "image/jpeg";
      if (out.data.length <= previewLimits.bytes) break;
    }
  }
  if (out.data.length > previewLimits.bytes)
    throw new ToolError("preview_too_large");
  return {
    data: out.data.toString("base64"),
    mimeType,
    width: out.info.width,
    height: out.info.height,
    sourceWidth: info.width,
    sourceHeight: info.height,
    sourceBytes: data.length,
    bytes: out.data.length,
    transformed: true,
    firstFrameOnly: info.animated,
    whiteBackground,
  };
}
