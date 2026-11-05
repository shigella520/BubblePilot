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
export class AttachmentService {
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
    return new AttachmentSession(
      input,
      plugins,
      this.sources,
      this.downloader,
      this.storage,
    );
  }
}
