import type { ContextMessage } from "../archive/archive-repository.js";
import { promptMessage, type PromptAttachment } from "../ai/prompt-xml.js";
import { messageAuthor } from "../identity/bot-identity.js";
import {
  attachmentImageReference,
  isImageAttachment,
  linkPreviewImageReference,
} from "../ai/image-reference.js";
import { sha256 } from "../../app/canonical-json.js";
import { modelTimestamp } from "./context-time.js";

export function conversationMessageContent(
  message: ContextMessage,
  timeZone: string,
  section: "chat_history" | "current_message" = "chat_history",
  attachments: readonly PromptAttachment[] = [],
): string {
  return promptMessage(section, {
    ...message,
    id: message.providerMessageId,
    text: message.body,
    sentAt: modelTimestamp(message.sentAt, timeZone),
    author: messageAuthor(message),
    attachments,
  });
}

export function historyAttachmentProjection(
  message: ContextMessage,
  providedReferences: ReadonlySet<string>,
): PromptAttachment[] {
  const sources = [
    ...message.attachments.flatMap((attachment, index) =>
      isImageAttachment(attachment)
        ? [
            {
              sourceType: "attachment" as const,
              sourceKey: attachment.providerAttachmentId,
              reference: attachmentImageReference(
                message.providerMessageId,
                index,
              ),
            },
          ]
        : [],
    ),
    ...message.linkPreview.items
      .filter((item) => item.imageUrl !== null)
      .slice(0, 1)
      .map((item) => ({
        sourceType: "link-preview" as const,
        sourceKey: item.imageUrl ?? "",
        reference: linkPreviewImageReference(message.providerMessageId),
      })),
  ];
  if (sources.length === 0) return [];
  const summaries = message.imageSummaries ?? [];
  return sources.map((source): PromptAttachment => {
    if (providedReferences.has(source.reference))
      return { id: source.reference, status: "provided" };
    const summary = summaries.find(
      (item) =>
        item.attachmentRef === source.reference &&
        item.sourceType === source.sourceType &&
        item.sourceKeyHash === sha256(source.sourceKey) &&
        item.status === "succeeded" &&
        item.summary !== null,
    );
    return {
      id: source.reference,
      status: summary?.summary ? "summarized" : "unavailable",
      summary:
        summary?.summary ??
        "历史图片尚未提供，无法确认图片内容，不得推断；仅在有本轮看图工具引用时可尝试读取。",
    };
  });
}
