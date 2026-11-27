import type { Pool } from "pg";
import type { BlueBubblesSettingsService } from "../integrations/bluebubbles/settings-service.js";
import { BlueBubblesAttachmentDownloader } from "../integrations/bluebubbles/attachment-download.js";
import { ChatImageSourceRepository } from "../ai/chat-image-source.js";
import type { PluginSession } from "../plugins/plugin-session.js";
import { AttachmentError } from "./attachment-policy.js";
import {
  AttachmentSession,
  type AttachmentRunInput,
} from "./attachment-session.js";
import type { AttachmentStore } from "./attachment-store.js";
import {
  attachmentContextMessage,
  type AttachmentContextMessage,
} from "./attachment-catalogue.js";
import type { MessageAttachment } from "../ingestion/message-envelope.js";
export class AttachmentService {
  /**
   * Loads the quoted message's attachments so the directory can issue refs.
   * Only same-chat, earlier, readable messages qualify; issuing a ref still
   * goes through the historical authorization check of the session.
   */
  private async quoted(
    input: AttachmentRunInput,
  ): Promise<AttachmentContextMessage | undefined> {
    if (!input.quotedMessageId) return undefined;
    const row = (
      await this.pool.query<{
        provider_message_id: string;
        sent_at: Date;
        sender_id: string | null;
        attachments: MessageAttachment[];
      }>(
        `SELECT m.provider_message_id,m.sent_at,m.sender_id,m.attachments
         FROM messages m JOIN chats c ON c.id=m.chat_id
         JOIN messages t ON t.chat_id=c.id AND t.provider=$1 AND t.provider_message_id=$3
         WHERE m.provider=$1 AND c.provider_chat_id=$2 AND m.provider_message_id=$4
         AND c.enabled AND c.deleted_at IS NULL AND m.content_redacted_at IS NULL
         AND m.revision_state='active' AND m.message_index<t.message_index
         AND m.attachments<>'[]'::jsonb`,
        [
          input.scope.provider,
          input.scope.providerChatId,
          input.scope.triggerMessageId,
          input.quotedMessageId,
        ],
      )
    ).rows[0];
    if (!row) return undefined;
    return attachmentContextMessage(
      {
        providerMessageId: row.provider_message_id,
        sentAt: row.sent_at.toISOString(),
        senderId: row.sender_id,
        attachments: row.attachments,
        revisionState: "active",
      },
      input.timeZone,
    );
  }
  readonly sources;
  readonly downloader;
  constructor(
    private readonly pool: Pool,
    settings: BlueBubblesSettingsService,
    readonly storage: AttachmentStore,
  ) {
    this.sources = new ChatImageSourceRepository(pool);
    this.downloader = new BlueBubblesAttachmentDownloader(settings);
  }
  async create(input: AttachmentRunInput, plugins: PluginSession) {
    // Never grant file access for a fabricated/idle/scheduled or Bot trigger.
    const result = await this.pool.query<{ allowed: boolean }>(
      `SELECT true AS allowed FROM messages m JOIN chats c ON c.id=m.chat_id
       WHERE m.provider=$1 AND m.provider_message_id=$2 AND c.provider_chat_id=$3
       AND c.enabled AND c.deleted_at IS NULL AND m.content_redacted_at IS NULL
       AND NOT m.is_from_me AND bot_message_author(m.id)->>'kind'='participant'`,
      [
        input.scope.provider,
        input.scope.triggerMessageId,
        input.scope.providerChatId,
      ],
    );
    if (!result.rows[0]?.allowed || input.scope.idleExecutionId)
      throw new AttachmentError("ATTACHMENT_TRIGGER_NOT_AUTHORIZED");
    const quoted = await this.quoted(input);
    return new AttachmentSession(
      quoted ? { ...input, quoted } : input,
      plugins,
      this.sources,
      this.downloader,
      this.storage,
    );
  }
}
