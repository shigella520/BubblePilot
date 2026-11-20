import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { validateGeneratedGif } from "./gif-validation.js";
import yauzl from "yauzl";
import { load } from "cheerio";
import {
  GeneratedImageError,
  generatedImageLimits,
  generatedFileLimits,
  type ReplyFileType,
} from "./image-policy.js";
export async function validateGeneratedPng(bytes: Buffer) {
  if (!bytes.length || bytes.length > generatedImageLimits.bytes)
    throw new GeneratedImageError("IMAGE_TOO_LARGE");
  try {
    const image = sharp(bytes, {
      limitInputPixels: generatedImageLimits.pixels,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    if (metadata.format !== "png" || !metadata.width || !metadata.height)
      throw new Error();
    // APNG contains acTL even for one displayed frame. Reject the format rather than flattening it.
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) throw new Error();
      if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL")
        throw new GeneratedImageError("IMAGE_ANIMATED");
      offset += length + 12;
    }
    if (Math.max(metadata.width, metadata.height) > generatedImageLimits.edge)
      throw new GeneratedImageError("IMAGE_PIXELS_EXCEEDED");
    await image.timeout({ seconds: 5 }).raw().toBuffer();
    return {
      width: metadata.width,
      height: metadata.height,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
  } catch (error) {
    throw error instanceof GeneratedImageError
      ? error
      : new GeneratedImageError("IMAGE_INVALID");
  }
}

const mimeTypes: Record<ReplyFileType, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  zip: "application/zip",
};
function containsControl(text: string, allowTextWhitespace = false) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      code === 127 ||
      (code < 32 && !(allowTextWhitespace && [9, 10, 13].includes(code)))
    )
      return true;
  }
  return false;
}
function validWorkbookMetadata(xml: Map<string, string>) {
  const contentTypes = xml.get("[Content_Types].xml"),
    workbook = xml.get("xl/workbook.xml");
  if (
    !contentTypes ||
    !workbook ||
    [...xml.values()].some((value) => /<!DOCTYPE|<!ENTITY/i.test(value))
  )
    return false;
  // Decode XML attribute entities; do not let encoded macro content types bypass checks.
  const typesDoc = load(contentTypes, { xml: true });
  const types = typesDoc("[ContentType]")
    .map((_index, node) => typesDoc(node).attr("ContentType") ?? "")
    .get();
  const bookDoc = load(workbook, { xml: true }),
    root = bookDoc.root().children().first();
  const namespace = Object.values(root.attr() ?? {}).includes(
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  );
  return (
    namespace &&
    types.includes(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    ) &&
    !types.some((value) => /macroEnabled|vbaProject|macrosheet/i.test(value))
  );
}
export function replyFileName(path: string) {
  const name = basename(path).normalize("NFC");
  if (
    !name ||
    name.length > 160 ||
    Buffer.byteLength(name) > 240 ||
    containsControl(name) ||
    /[\\/\u202a-\u202e\u2066-\u2069]/u.test(name)
  )
    throw new GeneratedImageError("FILE_NAME_INVALID");
  return name;
}
async function validateZip(bytes: Buffer, xlsx: boolean, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new GeneratedImageError("FILE_ARCHIVE_INVALID"));
          return;
        }
        let finished = false,
          count = 0,
          expanded = 0;
        const names = new Set<string>();
        const xml = new Map<string, string>();
        const finish = (cause?: Error) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener("abort", aborted);
          zip.close();
          if (cause) reject(cause);
          else resolve();
        };
        const aborted = () =>
          finish(new GeneratedImageError("FILE_VALIDATION_CANCELLED"));
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) {
          aborted();
          return;
        }
        zip.on("error", () =>
          finish(new GeneratedImageError("FILE_ARCHIVE_INVALID")),
        );
        zip.on("end", () => {
          if (
            xlsx &&
            (!names.has("[Content_Types].xml") ||
              !names.has("xl/workbook.xml") ||
              !validWorkbookMetadata(xml))
          )
            finish(new GeneratedImageError("FILE_TYPE_MISMATCH"));
          else finish();
        });
        zip.on("entry", (entry: yauzl.Entry) => {
          if (finished) return;
          const name = entry.fileName;
          count++;
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (
            count > generatedFileLimits.entries ||
            entry.uncompressedSize + expanded >
              generatedFileLimits.expandedBytes
          ) {
            finish(new GeneratedImageError("FILE_ARCHIVE_LIMIT"));
            return;
          }
          if (
            names.has(name) ||
            name.startsWith("/") ||
            name.includes("\\") ||
            name.split("/").some((p) => p === "." || p === "..") ||
            containsControl(name) ||
            (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) ||
            entry.generalPurposeBitFlag & 1 ||
            (xlsx && /(?:vbaProject\.bin|macrosheets\/)/i.test(name))
          ) {
            finish(new GeneratedImageError("FILE_ARCHIVE_INVALID"));
            return;
          }
          names.add(name);
          const captureXml =
            xlsx && ["[Content_Types].xml", "xl/workbook.xml"].includes(name);
          if (captureXml && entry.uncompressedSize > 1024 * 1024) {
            finish(new GeneratedImageError("FILE_ARCHIVE_LIMIT"));
            return;
          }
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) {
              finish(new GeneratedImageError("FILE_ARCHIVE_INVALID"));
              return;
            }
            let size = 0,
              checksum = 0;
            const chunks: Buffer[] = [];
            const cancel = () => stream.destroy();
            signal.addEventListener("abort", cancel, { once: true });
            stream.on("data", (chunk: Buffer) => {
              size += chunk.length;
              checksum = crc32(chunk, checksum);
              expanded += chunk.length;
              if (
                expanded > generatedFileLimits.expandedBytes ||
                size > entry.uncompressedSize
              ) {
                stream.destroy();
                finish(new GeneratedImageError("FILE_ARCHIVE_LIMIT"));
              }
              if (captureXml && !finished) chunks.push(chunk);
            });
            stream.on("error", () =>
              finish(new GeneratedImageError("FILE_ARCHIVE_INVALID")),
            );
            stream.on("close", () =>
              signal.removeEventListener("abort", cancel),
            );
            stream.on("end", () => {
              if (finished) return;
              if (
                size !== entry.uncompressedSize ||
                checksum !== entry.crc32 >>> 0
              )
                finish(new GeneratedImageError("FILE_ARCHIVE_INVALID"));
              else {
                if (captureXml)
                  xml.set(name, Buffer.concat(chunks).toString("utf8"));
                zip.readEntry();
              }
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}
export function describeReplyFile(
  path: string,
  allowed: readonly ReplyFileType[],
) {
  const filename = replyFileName(path);
  const extension = extname(filename).slice(1).toLowerCase();
  const fileType = (extension === "jpg" ? "jpeg" : extension) as ReplyFileType;
  if (!Object.hasOwn(mimeTypes, fileType))
    throw new GeneratedImageError("FILE_TYPE_UNSUPPORTED");
  if (!allowed.includes(fileType))
    throw new GeneratedImageError("FILE_TYPE_NOT_AUTHORIZED");
  return { filename, fileType };
}
export async function validateReplyFile(
  bytes: Buffer,
  path: string,
  allowed: readonly ReplyFileType[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { filename, fileType } = describeReplyFile(path, allowed);
  if (!bytes.length || bytes.length > generatedFileLimits.bytes)
    throw new GeneratedImageError("FILE_TOO_LARGE");
  let width: number | null = null,
    height: number | null = null;
  if (fileType === "png") {
    ({ width, height } = await validateGeneratedPng(bytes));
  } else if (fileType === "jpeg") {
    if (bytes.length > generatedImageLimits.bytes)
      throw new GeneratedImageError("IMAGE_TOO_LARGE");
    try {
      const image = sharp(bytes, {
        limitInputPixels: generatedImageLimits.pixels,
        failOn: "warning",
      });
      const meta = await image.metadata();
      if (
        meta.format !== "jpeg" ||
        !meta.width ||
        !meta.height ||
        Math.max(meta.width, meta.height) > generatedImageLimits.edge
      )
        throw new Error();
      await image.timeout({ seconds: 5 }).raw().toBuffer();
      width = meta.width;
      height = meta.height;
    } catch {
      throw new GeneratedImageError("FILE_TYPE_MISMATCH");
    }
  } else if (fileType === "gif") {
    ({ width, height } = await validateGeneratedGif(bytes, signal));
  } else if (fileType === "pdf") {
    if (
      !/^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString("ascii")) ||
      !bytes.subarray(-1024).includes(Buffer.from("%%EOF"))
    )
      throw new GeneratedImageError("FILE_TYPE_MISMATCH");
  } else if (fileType === "xlsx" || fileType === "zip") {
    await validateZip(bytes, fileType === "xlsx", signal);
  } else {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (containsControl(text, true)) throw new Error();
    } catch {
      throw new GeneratedImageError("FILE_TEXT_ENCODING_INVALID");
    }
  }
  signal.throwIfAborted();
  return {
    filename,
    mimeType: mimeTypes[fileType],
    fileType,
    width,
    height,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
