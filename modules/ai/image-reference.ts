import { sha256 } from "../../app/canonical-json.js";
import type { MessageAttachment } from "../ingestion/message-envelope.js";

export function isImageAttachment(attachment: MessageAttachment): boolean {
  if (attachment.mimeType?.toLowerCase().startsWith("image/")) return true;
  return /\.(?:jpe?g|png|webp|gif|heic|heif)$/iu.test(
    attachment.fileName ?? "",
  );
}

export function messageImageReference(providerMessageId: string): string {
  return `message-${sha256(providerMessageId).slice(0, 16)}`;
}

export function attachmentImageReference(
  providerMessageId: string,
  index: number,
): string {
  return `${messageImageReference(providerMessageId)}:attachment:${index + 1}`;
}

export function linkPreviewImageReference(providerMessageId: string): string {
  return `${messageImageReference(providerMessageId)}:link:1:image`;
}
