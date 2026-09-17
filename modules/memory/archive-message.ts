import type { MessageAuthor } from "../identity/bot-identity.js";
import { contentHash, type MemoryMessage } from "./chunking.js";
export interface MessageRow {
  id: string;
  message_index: string;
  sent_at: Date | string;
  sender_id: string | null;
  is_from_me: boolean;
  author?: MessageAuthor;
  body: string | null;
  attachments: unknown;
  link_previews: unknown;
  images: string | null;
}
export function memoryMessage(row: MessageRow): MemoryMessage {
  const sentAt = new Date(row.sent_at);
  const text = [
    row.body ?? "",
    JSON.stringify(row.attachments),
    JSON.stringify(row.link_previews),
    row.images ?? "",
  ]
    .filter((v) => v && v !== "[]")
    .join("\n");
  return {
    id: row.id,
    index: Number(row.message_index),
    sentAt: sentAt.toISOString(),
    senderId: row.sender_id ?? (row.is_from_me ? "Bot" : "unknown"),
    role: "user",
    author:
      row.author ??
      (row.is_from_me
        ? { kind: "unknown-self" }
        : { kind: "participant", senderId: row.sender_id }),
    text,
    hash: contentHash(
      JSON.stringify([
        text,
        row.sender_id,
        row.is_from_me,
        // Attribution diagnostics do not change the unknown author identity.
        row.author?.kind === "unknown-self"
          ? { kind: "unknown-self" }
          : (row.author ?? null),
        sentAt,
      ]),
    ),
  };
}
export const messageColumns = `m.id,m.message_index,m.sent_at,m.sender_id,m.is_from_me,bot_message_author(m.id) AS author,m.body,m.attachments,m.link_previews,
 (SELECT string_agg(s.summary,E'\n' ORDER BY s.id) FROM message_image_summaries s WHERE s.message_id=m.id AND s.status='succeeded') images`;
