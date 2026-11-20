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
  triggerMessageId: string | null;
  idleExecutionId?: string;
  executionId?: string;
}
/** The archive, not the gateway, is authoritative for source access. */
export class ChatImageSourceRepository {
  constructor(private readonly pool: Pool) {}
  async authorized(
    scope: ChatImageScope,
    guid: string,
    historical: boolean,
  ): Promise<boolean> {
    if (scope.executionId)
      await this.pool.query("SELECT freeze_execution_history($1)", [
        scope.executionId,
      ]);
    const result = await this.pool.query(
      `SELECT 1 FROM messages m JOIN chats c ON c.id=m.chat_id
      LEFT JOIN messages trigger ON trigger.chat_id=c.id AND trigger.provider=$1 AND trigger.provider_message_id=$3
      LEFT JOIN workflow_executions idle ON idle.id=$6 AND idle.target_chat_id=c.id
        AND idle.trigger_event->>'schemaVersion' IN ('chat-idle-v1','scheduled-task-v1','scheduled-task-v2')
      WHERE m.provider=$1 AND c.provider=$1 AND c.provider_chat_id=$2 AND m.provider_message_id=$4
      AND c.enabled AND c.deleted_at IS NULL AND m.content_redacted_at IS NULL
      AND ((trigger.id IS NOT NULL AND trigger.content_redacted_at IS NULL AND (CASE WHEN $7::uuid IS NOT NULL THEN (EXISTS(SELECT 1 FROM workflow_executions e WHERE e.id=$7 AND e.source_message_id=trigger.id) AND execution_history_allows($7,m.id,true)) ELSE m.message_index<=trigger.message_index END))
        OR (idle.id IS NOT NULL AND m.message_index<(COALESCE(idle.trigger_event->'idle'->>'upperMessageIndex',idle.trigger_event->'scheduled'->>'upperMessageIndex'))::bigint))
      AND (NOT $5 OR ((idle.id IS NOT NULL OR m.id<>trigger.id)
        AND EXISTS(SELECT 1 FROM memory_settings WHERE enabled)
        AND EXISTS(SELECT 1 FROM memory_chats mc WHERE mc.chat_id=c.id AND mc.enabled)))`,
      [
        scope.provider,
        scope.providerChatId,
        scope.triggerMessageId,
        guid,
        historical,
        scope.idleExecutionId ?? null,
        scope.executionId ?? null,
      ],
    );
    return !!result.rowCount;
  }
  async resolve(
    scope: ChatImageScope,
    providerMessageId: string,
    attachmentIndex: number,
    historical: boolean,
  ): Promise<ChatImageSource | null> {
    if (scope.executionId)
      await this.pool.query("SELECT freeze_execution_history($1)", [
        scope.executionId,
      ]);
    const result = await this.pool.query<{
      id: string;
      provider_message_id: string;
      attachments: MessageAttachment[];
    }>(
      `SELECT m.id,m.provider_message_id,m.attachments FROM messages m
       JOIN chats c ON c.id=m.chat_id
       LEFT JOIN messages trigger ON trigger.chat_id=c.id AND trigger.provider=$1 AND trigger.provider_message_id=$3
       LEFT JOIN workflow_executions idle ON idle.id=$6 AND idle.target_chat_id=c.id
         AND idle.trigger_event->>'schemaVersion' IN ('chat-idle-v1','scheduled-task-v1','scheduled-task-v2')
       WHERE m.provider=$1 AND c.provider=$1 AND c.provider_chat_id=$2 AND m.provider_message_id=$4
       AND c.enabled AND c.deleted_at IS NULL AND m.content_redacted_at IS NULL
       AND ((trigger.id IS NOT NULL AND trigger.content_redacted_at IS NULL AND (CASE WHEN $7::uuid IS NOT NULL THEN (EXISTS(SELECT 1 FROM workflow_executions e WHERE e.id=$7 AND e.source_message_id=trigger.id) AND execution_history_allows($7,m.id,true)) ELSE m.message_index<=trigger.message_index END))
         OR (idle.id IS NOT NULL AND m.message_index<(COALESCE(idle.trigger_event->'idle'->>'upperMessageIndex',idle.trigger_event->'scheduled'->>'upperMessageIndex'))::bigint))
       AND (NOT $5 OR ((idle.id IS NOT NULL OR m.id<>trigger.id)
         AND EXISTS(SELECT 1 FROM memory_settings WHERE enabled)
         AND EXISTS(SELECT 1 FROM memory_chats mc WHERE mc.chat_id=c.id AND mc.enabled)))`,
      [
        scope.provider,
        scope.providerChatId,
        scope.triggerMessageId,
        providerMessageId,
        historical,
        scope.idleExecutionId ?? null,
        scope.executionId ?? null,
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
