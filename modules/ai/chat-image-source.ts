import type { Pool } from "pg";
import type { MessageAttachment } from "../ingestion/message-envelope.js";

export interface ChatImageSource {
  messageId: string;
  providerMessageId: string;
  attachment: MessageAttachment;
  attachmentIndex: number;
}
export interface ChatImageScope {
  provider: string;
  providerChatId: string;
  triggerMessageId: string;
}
/** The archive, not the gateway, is authoritative for source access. */
export class ChatImageSourceRepository {
  constructor(private readonly pool: Pool) {}
  async resolve(
    scope: ChatImageScope,
    providerMessageId: string,
    attachmentIndex: number,
    historical: boolean,
  ): Promise<ChatImageSource | null> {
    const result = await this.pool.query<{
      id: string;
      provider_message_id: string;
      attachments: MessageAttachment[];
    }>(
      `SELECT m.id,m.provider_message_id,m.attachments FROM messages m
       JOIN chats c ON c.id=m.chat_id
       JOIN messages trigger ON trigger.chat_id=c.id AND trigger.provider=$1 AND trigger.provider_message_id=$3
       WHERE m.provider=$1 AND c.provider=$1 AND c.provider_chat_id=$2 AND m.provider_message_id=$4
       AND c.enabled AND c.deleted_at IS NULL AND m.content_redacted_at IS NULL
       AND trigger.content_redacted_at IS NULL AND m.message_index<=trigger.message_index
       AND (NOT $5 OR (m.message_index<trigger.message_index
         AND EXISTS(SELECT 1 FROM memory_settings WHERE enabled)
         AND EXISTS(SELECT 1 FROM memory_chats mc WHERE mc.chat_id=c.id AND mc.enabled)))`,
      [
        scope.provider,
        scope.providerChatId,
        scope.triggerMessageId,
        providerMessageId,
        historical,
      ],
    );
    const row = result.rows[0];
    const attachment = row?.attachments[attachmentIndex];
    return row && attachment
      ? {
          messageId: row.id,
          providerMessageId: row.provider_message_id,
          attachment,
          attachmentIndex,
        }
      : null;
  }
}
