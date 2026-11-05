import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { MessageAttachment } from "../ingestion/message-envelope.js";
import { AttachmentError } from "./attachment-policy.js";
const textTypes: Record<string, string[]> = {
  txt: ["text/plain"],
  csv: ["text/csv", "application/csv"],
  tsv: ["text/tab-separated-values"],
  json: ["application/json", "text/json"],
  yaml: ["application/yaml", "text/yaml", "application/x-yaml"],
  yml: ["application/yaml", "text/yaml", "application/x-yaml"],
  log: ["text/plain"],
  html: ["text/html"],
  htm: ["text/html"],
  md: ["text/markdown", "text/plain"],
  xml: ["application/xml", "text/xml"],
};
const binaryTypes: Record<string, string[]> = {
  pdf: ["application/pdf"],
  xlsx: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/zip",
  ],
  zip: ["application/zip", "application/x-zip-compressed"],
  tar: ["application/x-tar"],
  gz: ["application/gzip", "application/x-gzip"],
  tgz: [
    "application/gzip",
    "application/x-gzip",
    "application/x-compressed-tar",
  ],
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  gif: ["image/gif"],
  webp: ["image/webp"],
};
export function attachmentFilename(attachment: MessageAttachment) {
  const raw = attachment.fileName ?? "attachment.txt";
  const extension = raw.split(".").at(-1)?.toLowerCase() ?? "";
  const types = textTypes[extension] ?? binaryTypes[extension];
  const mime = attachment.mimeType?.split(";")[0]?.trim().toLowerCase();
  if (
    !types ||
    (mime && mime !== "application/octet-stream" && !types.includes(mime))
  )
    throw new AttachmentError("ATTACHMENT_TYPE_UNSUPPORTED_OR_CONFLICTING");
  const safe = [...raw.normalize("NFKC")]
    .map((c) =>
      c === "/" || c === "\\" || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
        ? "_"
        : c,
    )
    .join("")
    .replace(/^\.+/u, "_");
  return {
    filename:
      [...safe]
        .slice(0, 60)
        .join("")
        .replace(/\.[^.]*$/u, "") +
      "." +
      extension,
    extension,
  };
}
export async function validateAttachmentFile(
  file: string,
  extension: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const fd = await open(file, "r");
  const bytes = Buffer.alloc(512);
  try {
    await fd.read(bytes, 0, bytes.length, 0);
  } finally {
    await fd.close();
  }
  const starts = (value: number[] | string) =>
    bytes.subarray(0, Buffer.from(value).length).equals(Buffer.from(value));
  if (textTypes[extension]) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      for await (const chunk of createReadStream(file, { signal })) {
        const data = chunk as Buffer;
        if (data.includes(0)) throw new Error("binary");
        decoder.decode(data, { stream: true });
      }
      decoder.decode();
      return;
    } catch {
      throw new AttachmentError("ATTACHMENT_TEXT_ENCODING_UNSUPPORTED");
    }
  }
  const valid =
    extension === "pdf"
      ? starts("%PDF-")
      : ["xlsx", "zip"].includes(extension)
        ? starts([80, 75, 3, 4]) || starts([80, 75, 5, 6])
        : ["gz", "tgz"].includes(extension)
          ? starts([31, 139])
          : extension === "tar"
            ? bytes.subarray(257, 262).toString() === "ustar"
            : extension === "png"
              ? starts([137, 80, 78, 71, 13, 10, 26, 10])
              : ["jpg", "jpeg"].includes(extension)
                ? starts([255, 216, 255])
                : extension === "gif"
                  ? starts("GIF87a") || starts("GIF89a")
                  : extension === "webp"
                    ? starts("RIFF") &&
                      bytes.subarray(8, 12).toString() === "WEBP"
                    : false;
  if (!valid) throw new AttachmentError("ATTACHMENT_TYPE_MISMATCH");
}
