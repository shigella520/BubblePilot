import { create } from "xmlbuilder2";
import type { MessageAuthor } from "../identity/bot-identity.js";
import {
  messageRevisionNotice,
  visibleRevisionText,
  type ReplyPreview,
  type RevisionState,
} from "../archive/message-revision.js";
import type { LinkPreviewBundle } from "../ingestion/link-preview.js";

// Only this module owns XML structure. Callers supply data, never XML nodes.
// The pinned dependency patch preserves literal entities and CR on object conversion
// and XML output. Do not remove it without the round-trip regression suite.
const options = { version: "1.0" as const, invalidCharReplacement: "\uFFFD" };
function serialize(value: object): string {
  return create(options, value).end({
    headless: true,
    wellFormed: true,
    prettyPrint: false,
    allowEmptyTags: true,
  });
}
export type PromptTextSection =
  | "static_task"
  | "dynamic_task"
  | "upstream_input"
  | "idle_task"
  | "ai_system"
  | "input_protocol"
  | "web_search_policy"
  | "resource_diagnostics"
  | "agent_budget_status"
  | "participant_identities"
  | "bot_identity"
  | "history_coverage";
export function promptText(
  section: PromptTextSection,
  text: string,
  source?: string,
): string {
  return serialize({
    [section]: {
      ...(source === undefined ? {} : { "@source": source }),
      "#": text,
    },
  });
}
export interface PromptAttachment {
  id: string;
  status: "provided" | "summarized" | "unavailable";
  summary?: string;
}
export interface PromptMessage {
  id: string;
  senderId: string | null;
  sentAt: string;
  author: MessageAuthor;
  text: string;
  replyTo?: ReplyPreview;
  revisionState?: RevisionState;
  editedAt?: string | null;
  attachments?: readonly PromptAttachment[];
  linkPreview?: LinkPreviewBundle;
}
function authorData(author: MessageAuthor) {
  return {
    "@kind": author.kind,
    ...(author.kind === "bot"
      ? {
          workflow_id: author.workflowId,
          nickname: author.nickname ?? "",
          version: author.version,
          basis: author.basis,
          revision: author.revision,
        }
      : author.kind === "participant"
        ? { sender_id: author.senderId ?? "" }
        : author.reason == null
          ? {}
          : { reason: author.reason }),
  };
}
function linkData(preview: LinkPreviewBundle | undefined) {
  if (!preview || preview.status === "not-requested") return undefined;
  if (preview.status !== "available")
    return { "@status": preview.status, "#": "链接预览不可用或仍在处理中。" };
  return {
    "@status": preview.status,
    item: preview.items.map((item) => ({
      url: item.url,
      title: item.title ?? "",
      summary: item.summary ?? "",
      site_name: item.siteName ?? "",
    })),
  };
}
export function promptLinkPreviewFingerprintInput(
  preview: LinkPreviewBundle,
): string | undefined {
  const data = linkData(preview);
  return data === undefined ? undefined : serialize({ link_previews: data });
}
export interface PromptMessageOptions {
  /**
   * History tool results only: a participant author whose sender_id equals the
   * message sender_id is emitted with only its kind attribute. The
   * message attribute remains the single application-owned identity, so the
   * projection stays unambiguous while avoiding a repeated identifier.
   */
  compactParticipantAuthor?: boolean;
}
export function promptMessage(
  section: "chat_history" | "current_message",
  data: PromptMessage,
  options: PromptMessageOptions = {},
): string {
  const reply = data.replyTo;
  const links = linkData(data.linkPreview);
  const notice = messageRevisionNotice(data);
  return serialize({
    [section]: {
      message: {
        "@id": data.id,
        "@sender_id": data.senderId ?? "",
        "@sent_at": data.sentAt,
        author:
          options.compactParticipantAuthor &&
          data.author.kind === "participant" &&
          (data.author.senderId ?? "") === (data.senderId ?? "")
            ? { "@kind": "participant" }
            : authorData(data.author),
        text: { "#": visibleRevisionText(data, data.text) },
        ...(notice ? { revision_notice: notice } : {}),
        ...(reply
          ? {
              reply_to: {
                "@status": reply.status,
                ...(reply.message_id === undefined
                  ? {}
                  : { message_id: reply.message_id }),
                ...(reply.archive_id === undefined
                  ? {}
                  : { archive_id: reply.archive_id }),
                ...(reply.message_index === undefined
                  ? {}
                  : { message_index: reply.message_index }),
                ...(reply.sender_id === undefined
                  ? {}
                  : { sender_id: reply.sender_id }),
                ...(reply.author === undefined
                  ? {}
                  : { author: JSON.stringify(reply.author) }),
                ...(reply.part_id === undefined
                  ? {}
                  : { part_id: reply.part_id }),
                ...(reply.text_preview === undefined
                  ? {}
                  : { text_preview: reply.text_preview }),
                ...(reply.truncated === undefined
                  ? {}
                  : { truncated: String(reply.truncated) }),
                ...(reply.sent_at === undefined
                  ? {}
                  : { sent_at: reply.sent_at }),
                ...(reply.attachments?.length
                  ? {
                      attachments: {
                        "@count": String(
                          reply.attachment_count ?? reply.attachments.length,
                        ),
                        attachment: reply.attachments.map((a) => ({
                          "@index": String(a.index),
                          ...(a.file_name === undefined
                            ? {}
                            : { "@file_name": a.file_name }),
                          ...(a.mime_type === undefined
                            ? {}
                            : { "@mime_type": a.mime_type }),
                        })),
                      },
                    }
                  : {}),
              },
            }
          : {}),
        ...(data.revisionState && data.revisionState !== "active"
          ? { message_state: data.revisionState }
          : {}),
        ...(links === undefined ? {} : { link_previews: links }),
        ...(data.attachments?.length
          ? {
              history_attachments: {
                attachment_ref: data.attachments.map((a) => ({
                  "@id": a.id,
                  "@status": a.status,
                  ...(a.summary === undefined
                    ? {}
                    : { image_summary: a.summary }),
                })),
              },
            }
          : {}),
      },
    },
  });
}
export function currentAttachments(references: readonly string[]): string {
  return serialize({
    current_attachments: {
      attachment_ref: references.map((id) => ({ "@id": id })),
    },
  });
}
export function systemTemplateData(
  template: string,
  values: Readonly<Record<string, string>>,
): string | null {
  const names = [
    ...new Set(
      [...template.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9._]*)\s*\}\}/gu)].map(
        (match) => match[1]!,
      ),
    ),
  ].sort();
  return names.length
    ? serialize({
        system_template_data: {
          variable: names.map((name) => ({
            "@name": name,
            "#": values[name] ?? "",
          })),
        },
      })
    : null;
}
export function imageSummaryRequest(
  contract: string,
  targetCharacters: number,
): string {
  return serialize({
    image_summary_request: {
      "@contract": contract,
      "#": `请将这张图片概括为不超过 ${targetCharacters} 个字符的历史上下文摘要。`,
    },
  });
}
