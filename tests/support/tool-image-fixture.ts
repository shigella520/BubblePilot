import sharp from "sharp";
import type { PreparedImageInput } from "../../modules/ai/native-image-input.js";
export function preparedImages(): PreparedImageInput {
  return {
    parts: [],
    items: [],
    selectedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    totalBytes: 0,
    settings: {
      enabled: true,
      includeAttachments: false,
      includeLinkPreviewImages: false,
      trustedLinkPreviewHosts: [],
      maxCurrentAttachments: 1,
      maxHistoryImages: 0,
      maxTotalImages: 2,
      maxImageBytes: 1024 * 1024,
      maxTotalBytes: 2 * 1024 * 1024,
      fetchTimeoutMs: 5000,
      detail: "auto",
    },
  };
}
export async function imageBlock(color = "red") {
  return {
    type: "image",
    mimeType: "image/png",
    data: (
      await sharp({
        create: { width: 32, height: 24, channels: 3, background: color },
      })
        .png()
        .toBuffer()
    ).toString("base64"),
  };
}
