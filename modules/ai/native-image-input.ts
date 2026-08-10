import { sha256 } from "../../app/canonical-json.js";
import type { ContextMessage } from "../archive/archive-repository.js";
import type { BlueBubblesSettingsService } from "../integrations/bluebubbles/settings-service.js";
import {
  fetchPublicResource,
  OpenGraphFetchError,
} from "../integrations/bluebubbles/open-graph-client.js";
import type {
  MessageAttachment,
  MessageEnvelope,
} from "../ingestion/message-envelope.js";
import type { LinkPreviewItem } from "../ingestion/link-preview.js";
import type { AiRepository } from "./ai-repository.js";
import type {
  AiImageContentPart,
  AiImageInputRecordInput,
} from "./ai-types.js";
import type { ImageInputSettingsService } from "./image-input-settings-service.js";
import type { ImageInputRuntimeSettings } from "./image-input-settings-types.js";

type ImageCandidate = {
  providerMessageId: string;
} & (
  | {
      source: "attachment";
      attachment: MessageAttachment;
      label: string;
    }
  | {
      source: "link-preview";
      preview: LinkPreviewItem;
      label: string;
    }
);

export interface PreparedImageInputItem {
  providerMessageId: string;
  part: AiImageContentPart;
}

export interface PreparedImageInput {
  parts: readonly AiImageContentPart[];
  items: readonly PreparedImageInputItem[];
  selectedCount: number;
  failedCount: number;
  skippedCount: number;
  totalBytes: number;
}

class ImageInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function imageMime(body: Buffer): string | null {
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

function isDeclaredImage(attachment: MessageAttachment): boolean {
  if (attachment.mimeType?.toLowerCase().startsWith("image/")) return true;
  return /\.(?:jpe?g|png|webp|gif|heic|heif)$/iu.test(
    attachment.fileName ?? "",
  );
}

function hostName(value: string | null): string | null {
  if (value === null) return null;
  try {
    return new URL(value).hostname.slice(0, 255);
  } catch {
    return null;
  }
}

async function limitedResponseBody(
  response: Response,
  maximumBytes: number,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes)
    throw new ImageInputError("AI_IMAGE_TOO_LARGE");
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    const value = item.value as Uint8Array;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new ImageInputError("AI_IMAGE_TOO_LARGE");
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes,
  );
}

function currentCandidates(
  envelope: MessageEnvelope,
  settings: ImageInputRuntimeSettings,
): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  if (settings.includeAttachments) {
    for (const [index, attachment] of envelope.message.attachments
      .filter(isDeclaredImage)
      .slice(0, settings.maxCurrentAttachments)
      .entries()) {
      candidates.push({
        providerMessageId: envelope.message.providerMessageId,
        source: "attachment",
        attachment,
        label: `紧邻上一条消息的图片附件 ${index + 1}`,
      });
    }
  }
  const preview = envelope.message.linkPreview.items.find(
    (item) => item.imageUrl !== null,
  );
  if (settings.includeLinkPreviewImages && preview !== undefined)
    candidates.push({
      providerMessageId: envelope.message.providerMessageId,
      source: "link-preview",
      preview,
      label: "紧邻上一条消息的链接卡片主图",
    });
  return candidates;
}

function historyCandidates(
  history: readonly ContextMessage[],
  settings: ImageInputRuntimeSettings,
): ImageCandidate[] {
  const result: ImageCandidate[] = [];
  for (let offset = history.length - 1; offset >= 0; offset -= 1) {
    const message = history[offset];
    if (message === undefined) continue;
    const preview = message.linkPreview.items.find(
      (item) => item.imageUrl !== null,
    );
    if (settings.includeLinkPreviewImages && preview !== undefined)
      result.push({
        providerMessageId: message.providerMessageId,
        source: "link-preview",
        preview,
        label: "紧邻上一条消息的链接卡片主图",
      });
    if (settings.includeAttachments) {
      for (const [index, attachment] of message.attachments
        .filter(isDeclaredImage)
        .entries()) {
        result.push({
          providerMessageId: message.providerMessageId,
          source: "attachment",
          attachment,
          label: `紧邻上一条消息的图片附件 ${index + 1}`,
        });
      }
    }
    if (result.length >= settings.maxHistoryImages) break;
  }
  return result.slice(0, settings.maxHistoryImages);
}

export class NativeImageInputService {
  constructor(
    private readonly settings: ImageInputSettingsService,
    private readonly blueBubbles: BlueBubblesSettingsService,
    private readonly repository?: Pick<AiRepository, "recordImageInput">,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async prepare(input: {
    executionId: string;
    nodeId: string;
    envelope: MessageEnvelope;
    history: readonly ContextMessage[];
    includeHistory: boolean;
  }): Promise<PreparedImageInput> {
    const settings = await this.settings.resolve();
    if (!settings.enabled)
      return {
        parts: [],
        items: [],
        selectedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        totalBytes: 0,
      };
    const all = [
      ...currentCandidates(input.envelope, settings),
      ...(input.includeHistory
        ? historyCandidates(input.history, settings)
        : []),
    ];
    const selected = all.slice(0, settings.maxTotalImages);
    let skippedCount = all.length - selected.length;
    let failedCount = 0;
    let totalBytes = 0;
    const parts: AiImageContentPart[] = [];
    const items: PreparedImageInputItem[] = [];
    const needsAttachmentDownload = selected.some(
      (candidate) => candidate.source === "attachment",
    );
    const blueBubblesSettings = needsAttachmentDownload
      ? await this.blueBubbles.resolve()
      : null;

    for (const candidate of selected) {
      const startedAt = Date.now();
      const identity =
        candidate.source === "attachment"
          ? candidate.attachment.providerAttachmentId
          : (candidate.preview.imageUrl ?? candidate.preview.url);
      const imageHostName =
        candidate.source === "link-preview" &&
        candidate.preview.imageUrl !== null
          ? hostName(candidate.preview.imageUrl)
          : null;
      let body: Buffer | null = null;
      let actualMimeType: string | null = null;
      let errorCode: string | null = null;
      try {
        if (candidate.source === "attachment") {
          if (blueBubblesSettings === null)
            throw new ImageInputError("AI_IMAGE_BLUEBUBBLES_UNAVAILABLE");
          const controller = new AbortController();
          const timeout = setTimeout(
            () => controller.abort(),
            settings.fetchTimeoutMs,
          );
          try {
            const endpoint = new URL(
              `/api/v1/attachment/${encodeURIComponent(candidate.attachment.providerAttachmentId)}/download`,
              `${blueBubblesSettings.serverUrl}/`,
            );
            endpoint.searchParams.set(
              "password",
              blueBubblesSettings.accessToken,
            );
            endpoint.searchParams.set("original", "false");
            const response = await this.fetchImplementation(endpoint, {
              headers: { accept: "image/*" },
              signal: controller.signal,
            });
            if (!response.ok)
              throw new ImageInputError(
                `AI_IMAGE_BLUEBUBBLES_HTTP_${response.status}`,
              );
            body = await limitedResponseBody(response, settings.maxImageBytes);
          } finally {
            clearTimeout(timeout);
          }
        } else {
          if (candidate.preview.imageUrl === null)
            throw new ImageInputError("AI_IMAGE_URL_UNAVAILABLE");
          const resource = await fetchPublicResource(
            candidate.preview.imageUrl,
            settings.fetchTimeoutMs,
            settings.maxImageBytes,
            "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8",
            { trustedProxyHosts: settings.trustedLinkPreviewHosts },
          );
          body = resource.body;
        }
        actualMimeType = imageMime(body);
        if (actualMimeType === null)
          throw new ImageInputError("AI_IMAGE_INVALID_CONTENT");
        if (totalBytes + body.length > settings.maxTotalBytes) {
          skippedCount += 1;
          errorCode = "AI_IMAGE_TOTAL_BYTES_EXCEEDED";
        } else {
          totalBytes += body.length;
          const part: AiImageContentPart = {
            type: "image",
            dataUrl: `data:${actualMimeType};base64,${body.toString("base64")}`,
            detail: settings.detail,
            label: candidate.label,
          };
          parts.push(part);
          items.push({
            providerMessageId: candidate.providerMessageId,
            part,
          });
        }
      } catch (error) {
        failedCount += 1;
        errorCode =
          error instanceof ImageInputError
            ? error.code
            : error instanceof OpenGraphFetchError
              ? error.code.replace("LINK_PREVIEW_OG_", "AI_IMAGE_")
              : error instanceof Error && error.name === "AbortError"
                ? "AI_IMAGE_FETCH_TIMEOUT"
                : "AI_IMAGE_FETCH_FAILED";
      }
      const record: AiImageInputRecordInput = {
        executionId: input.executionId,
        nodeId: input.nodeId,
        source: candidate.source,
        sourceHash: sha256(identity),
        hostName: imageHostName,
        status:
          errorCode === null
            ? "succeeded"
            : errorCode === "AI_IMAGE_TOTAL_BYTES_EXCEEDED"
              ? "skipped"
              : "failed",
        declaredMimeType:
          candidate.source === "attachment"
            ? candidate.attachment.mimeType
            : null,
        actualMimeType,
        bytes: body?.length ?? null,
        durationMs: Math.max(0, Date.now() - startedAt),
        detail: settings.detail,
        errorCode,
      };
      try {
        await this.repository?.recordImageInput(record);
      } catch {
        // Image diagnostics are best-effort and must never fail a workflow.
      }
    }

    return {
      parts,
      items,
      selectedCount: parts.length,
      failedCount,
      skippedCount,
      totalBytes,
    };
  }
}
