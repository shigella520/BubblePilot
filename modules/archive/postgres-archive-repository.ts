import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResult } from "pg";

import { createPostgresPool } from "../shared/postgres-pool.js";
import type { MessageAttachment } from "../ingestion/message-envelope.js";

import type {
  ArchiveRepository,
  ArchivedMessage,
  AutomationOutcome,
  ChatDeletionMutation,
  ChatMonitoringMutation,
  ChatParticipantIdentity,
  ChatParticipantIdentityMutation,
  ChatParticipantIdentitySet,
  ChatParticipantView,
  ChatSummary,
  ContextMessage,
  ContextWindowOptions,
  InboundEventSummary,
  IngestionResult,
  MessageSearchOptions,
  MessageSearchResult,
  MessageRetentionBatchInput,
  PageOptions,
} from "./archive-repository.js";
import type {
  IgnoredInboundEvent,
  MessageEnvelope,
} from "../ingestion/message-envelope.js";
import {
  linkPreviewItemSchema,
  linkPreviewStatusSchema,
  type LinkPreviewBundle,
  type LinkPreviewDiagnostic,
} from "../ingestion/link-preview.js";

interface IdentifierRow {
  id: string;
}

interface ClaimedEventRow extends IdentifierRow {
  automation_outcome: AutomationOutcome;
}

interface InboundEventRow {
  id: string;
  provider: string;
  external_event_id: string;
  correlation_id: string;
  event_type: string;
  status: "accepted" | "ignored" | "completed" | "failed";
  automation_outcome: AutomationOutcome;
  received_at: Date;
}

interface ChatRow {
  id: string;
  provider_chat_id: string;
  type: "direct" | "group" | "unknown";
  display_name: string | null;
  enabled: boolean;
  message_count: string;
  version: number;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  provider_message_id: string;
  sender_id: string | null;
  sent_at: Date;
  body: string | null;
  content_type: "text" | "attachment" | "mixed" | "unknown";
  is_from_me: boolean;
  attachments: unknown[];
  link_preview_status: string;
  link_previews: unknown;
  link_preview_error_code: string | null;
  link_preview_diagnostics: unknown;
  link_preview_fetched_at: Date | null;
  content_redacted_at: Date | null;
  created_at: Date;
}

interface MessageSearchRow extends MessageRow {
  chat_id: string;
  provider_chat_id: string;
  chat_display_name: string | null;
}

interface ContextMessageRow {
  message_index: string;
  provider_message_id: string;
  sender_id: string | null;
  sent_at: Date;
  body: string;
  is_from_me: boolean;
  attachments: unknown;
  link_preview_status: string;
  link_previews: unknown;
  link_preview_error_code: string | null;
}

interface ChatParticipantRow {
  sender_id: string;
  real_name: string | null;
  nickname: string | null;
  message_count: string;
  last_seen_at: Date;
}

interface ParticipantIdentityRow {
  sender_id: string;
  real_name: string | null;
  nickname: string | null;
}

function chatSummary(row: ChatRow): ChatSummary {
  return {
    id: row.id,
    providerChatId: row.provider_chat_id,
    type: row.type,
    displayName: row.display_name,
    enabled: row.enabled,
    messageCount: Number(row.message_count),
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

function archivedMessage(row: MessageRow): ArchivedMessage {
  return {
    id: row.id,
    providerMessageId: row.provider_message_id,
    senderId: row.sender_id,
    sentAt: row.sent_at.toISOString(),
    body: row.body,
    contentType: row.content_type,
    isFromMe: row.is_from_me,
    attachments: messageAttachments(row.attachments),
    linkPreview: linkPreviewBundle(row),
    linkPreviewDiagnostics: Array.isArray(row.link_preview_diagnostics)
      ? (row.link_preview_diagnostics as LinkPreviewDiagnostic[])
      : [],
    linkPreviewFetchedAt: row.link_preview_fetched_at?.toISOString() ?? null,
    contentRedactedAt: row.content_redacted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function linkPreviewBundle(row: {
  link_preview_status: string;
  link_previews: unknown;
  link_preview_error_code: string | null;
}): LinkPreviewBundle {
  const status = linkPreviewStatusSchema.safeParse(row.link_preview_status);
  const items = Array.isArray(row.link_previews)
    ? row.link_previews.flatMap((item) => {
        const parsed = linkPreviewItemSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  return {
    status: status.success ? status.data : "failed",
    errorCode: row.link_preview_error_code,
    items,
  };
}

function messageAttachments(value: unknown): readonly MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.providerAttachmentId !== "string") return [];
    return [
      {
        providerAttachmentId: record.providerAttachmentId,
        mimeType: typeof record.mimeType === "string" ? record.mimeType : null,
        fileName: typeof record.fileName === "string" ? record.fileName : null,
        sizeBytes:
          typeof record.sizeBytes === "number" ? record.sizeBytes : null,
      },
    ];
  });
}

function inboundEventSummary(row: InboundEventRow): InboundEventSummary {
  return {
    id: row.id,
    provider: row.provider,
    eventId: row.external_event_id,
    correlationId: row.correlation_id,
    eventType: row.event_type,
    ingestionStatus: row.status,
    automationOutcome: row.automation_outcome,
    receivedAt: row.received_at.toISOString(),
  };
}

function participantIdentity(
  row: ParticipantIdentityRow,
): ChatParticipantIdentity {
  return {
    senderId: row.sender_id,
    realName: row.real_name,
    nickname: row.nickname,
  };
}

function participantView(row: ChatParticipantRow): ChatParticipantView {
  return {
    ...participantIdentity(row),
    messageCount: Number(row.message_count),
    lastSeenAt: row.last_seen_at.toISOString(),
  };
}

export class PostgresArchiveRepository implements ArchiveRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string, queryTimeoutMs?: number) {
    this.pool = createPostgresPool(databaseUrl, 10, queryTimeoutMs);
  }

  async ingestMessage(
    envelope: MessageEnvelope,
    archiveEnabled: boolean,
  ): Promise<IngestionResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const event = await this.claimEvent(client, {
        id: randomUUID(),
        provider: envelope.provider,
        externalEventId: envelope.eventId,
        correlationId: envelope.correlationId,
        eventType: envelope.metadata.eventType,
        payloadHash: envelope.metadata.payloadHash,
      });

      if (event.rowCount === 0) {
        const existing = await this.readAutomationOutcome(
          client,
          envelope.provider,
          envelope.eventId,
        );
        await client.query("ROLLBACK");
        return {
          status: "duplicate",
          eventId: envelope.eventId,
          correlationId: envelope.correlationId,
          messageId: null,
          automationOutcome: existing,
        };
      }

      const eventId = event.rows[0]?.id;
      if (eventId === undefined) {
        throw new Error(
          "The claimed inbound event did not return an identifier.",
        );
      }

      const chatId = randomUUID();
      const chat = await client.query<IdentifierRow>(
        `INSERT INTO chats (
           id, provider, provider_chat_id, type, display_name, enabled
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (provider, provider_chat_id) DO UPDATE SET
           type = EXCLUDED.type,
           display_name = COALESCE(EXCLUDED.display_name, chats.display_name),
           deleted_at = NULL,
           updated_at = NOW()
         RETURNING id`,
        [
          chatId,
          envelope.provider,
          envelope.chat.providerChatId,
          envelope.chat.type,
          envelope.chat.displayName,
          archiveEnabled,
        ],
      );
      const persistedChatId = chat.rows[0]?.id;
      if (persistedChatId === undefined) {
        throw new Error("The archived chat did not return an identifier.");
      }

      if (!archiveEnabled) {
        await client.query(
          `UPDATE inbound_events
           SET status = 'ignored', automation_outcome = 'chat-not-monitored'
           WHERE id = $1`,
          [eventId],
        );
        await client.query("COMMIT");
        return {
          status: "ignored",
          eventId: envelope.eventId,
          correlationId: envelope.correlationId,
          messageId: null,
          automationOutcome: "chat-not-monitored",
        };
      }

      const messageId = randomUUID();
      const allocatedIndex = await client.query<{ message_index: string }>(
        `UPDATE chats
         SET next_message_index = next_message_index + 1
         WHERE id = $1
         RETURNING (next_message_index - 1)::text AS message_index`,
        [persistedChatId],
      );
      const messageIndex = allocatedIndex.rows[0]?.message_index;
      if (messageIndex === undefined) {
        throw new Error("The archived message did not receive an index.");
      }
      const message = await client.query<IdentifierRow>(
        `INSERT INTO messages (
           id, provider, provider_message_id, chat_id, sender_id, sent_at, body,
           content_type, is_from_me, content_hash, attachments, source_event_id,
           link_preview_status, link_previews, link_preview_error_code,
           message_index
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
                   $13, $14::jsonb, $15, $16)
         ON CONFLICT (provider, provider_message_id) DO NOTHING
         RETURNING id`,
        [
          messageId,
          envelope.provider,
          envelope.message.providerMessageId,
          persistedChatId,
          envelope.message.senderId,
          envelope.message.sentAt,
          envelope.message.text,
          envelope.message.contentType,
          envelope.message.isFromMe,
          envelope.message.contentHash,
          JSON.stringify(envelope.message.attachments),
          eventId,
          envelope.message.linkPreview.status,
          JSON.stringify(envelope.message.linkPreview.items),
          envelope.message.linkPreview.errorCode,
          messageIndex,
        ],
      );

      const persistedMessageId = message.rows[0]?.id ?? null;
      const initialAutomationOutcome: AutomationOutcome =
        persistedMessageId === null ? "not-evaluated" : "evaluation-pending";
      await client.query(
        `UPDATE inbound_events
         SET status = 'completed', automation_outcome = $2
         WHERE id = $1`,
        [eventId, initialAutomationOutcome],
      );
      await client.query("COMMIT");

      return {
        status: persistedMessageId === null ? "duplicate" : "archived",
        eventId: envelope.eventId,
        correlationId: envelope.correlationId,
        messageId: persistedMessageId,
        automationOutcome: initialAutomationOutcome,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      await this.recordFailure(envelope, error);
      throw error;
    } finally {
      client.release();
    }
  }

  async saveMessageLinkPreview(input: {
    providerMessageId: string;
    linkPreview: LinkPreviewBundle;
    diagnostics: readonly LinkPreviewDiagnostic[];
    fetchedAt: Date;
  }): Promise<LinkPreviewBundle | null> {
    const result = await this.pool.query<{
      link_preview_status: string;
      link_previews: unknown;
      link_preview_error_code: string | null;
    }>(
      `UPDATE messages
       SET link_preview_status = $2,
           link_previews = $3::jsonb,
           link_preview_error_code = $4,
           link_preview_diagnostics = $5::jsonb,
           link_preview_fetched_at = $6
       WHERE provider = 'bluebubbles' AND provider_message_id = $1
         AND link_preview_status = 'pending'
       RETURNING link_preview_status, link_previews, link_preview_error_code`,
      [
        input.providerMessageId,
        input.linkPreview.status,
        JSON.stringify(input.linkPreview.items),
        input.linkPreview.errorCode,
        JSON.stringify(input.diagnostics.slice(0, 5)),
        input.fetchedAt,
      ],
    );
    const row = result.rows[0];
    if (row !== undefined) return linkPreviewBundle(row);
    const existing = await this.pool.query<{
      link_preview_status: string;
      link_previews: unknown;
      link_preview_error_code: string | null;
    }>(
      `SELECT link_preview_status, link_previews, link_preview_error_code
       FROM messages
       WHERE provider = 'bluebubbles' AND provider_message_id = $1`,
      [input.providerMessageId],
    );
    const existingRow = existing.rows[0];
    return existingRow === undefined ? null : linkPreviewBundle(existingRow);
  }

  async recordIgnoredEvent(
    event: IgnoredInboundEvent,
  ): Promise<IngestionResult> {
    const result = await this.pool.query<ClaimedEventRow>(
      `INSERT INTO inbound_events (
         id, provider, external_event_id, correlation_id, event_type, status,
         payload_hash, error_code, automation_outcome
       ) VALUES ($1, $2, $3, $4, $5, 'ignored', $6, $7, 'unsupported-event')
       ON CONFLICT (provider, external_event_id) DO NOTHING
       RETURNING id, automation_outcome`,
      [
        randomUUID(),
        event.provider,
        event.eventId,
        event.correlationId,
        event.eventType,
        event.payloadHash,
        event.reason,
      ],
    );

    const automationOutcome =
      result.rows[0]?.automation_outcome ??
      (await this.readAutomationOutcome(
        this.pool,
        event.provider,
        event.eventId,
      ));
    return {
      status: result.rowCount === 0 ? "duplicate" : "ignored",
      eventId: event.eventId,
      correlationId: event.correlationId,
      messageId: null,
      automationOutcome,
    };
  }

  async recordAutomationOutcome(
    provider: string,
    eventId: string,
    outcome: AutomationOutcome,
  ): Promise<AutomationOutcome> {
    const updated = await this.pool.query<{
      automation_outcome: AutomationOutcome;
    }>(
      `UPDATE inbound_events
       SET automation_outcome = $3
       WHERE provider = $1
         AND external_event_id = $2
         AND automation_outcome = 'evaluation-pending'
       RETURNING automation_outcome`,
      [provider, eventId, outcome],
    );
    return (
      updated.rows[0]?.automation_outcome ??
      (await this.readAutomationOutcome(this.pool, provider, eventId))
    );
  }

  async listInboundEvents(
    options: PageOptions,
  ): Promise<readonly InboundEventSummary[]> {
    const result = await this.pool.query<InboundEventRow>(
      `SELECT
         id, provider, external_event_id, correlation_id, event_type, status,
         automation_outcome, received_at
       FROM inbound_events
       WHERE (
         $1::timestamptz IS NULL
         OR (received_at, id) < ($1::timestamptz, $2::uuid)
       )
       ORDER BY received_at DESC, id DESC
       LIMIT $3`,
      [
        options.cursor?.timestamp.toISOString() ?? null,
        options.cursor?.id ?? null,
        options.limit,
      ],
    );
    return result.rows.map(inboundEventSummary);
  }

  async listChats(options: PageOptions): Promise<readonly ChatSummary[]> {
    const result = await this.pool.query<ChatRow>(
      `SELECT
         c.id, c.provider_chat_id, c.type, c.display_name, c.enabled, c.version,
         c.updated_at,
         COUNT(m.id)::text AS message_count
       FROM chats c
       LEFT JOIN messages m ON m.chat_id = c.id
       WHERE c.enabled = TRUE
         AND c.deleted_at IS NULL
         AND (
           $1::timestamptz IS NULL
           OR (c.updated_at, c.id) < ($1::timestamptz, $2::uuid)
         )
       GROUP BY c.id
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT $3`,
      [
        options.cursor?.timestamp.toISOString() ?? null,
        options.cursor?.id ?? null,
        options.limit,
      ],
    );

    return result.rows.map(chatSummary);
  }

  async listChatMonitoring(
    options: PageOptions,
  ): Promise<readonly ChatSummary[]> {
    const result = await this.pool.query<ChatRow>(
      `SELECT
         c.id, c.provider_chat_id, c.type, c.display_name, c.enabled, c.version,
         c.updated_at, COUNT(m.id)::text AS message_count
       FROM chats c
       LEFT JOIN messages m ON m.chat_id = c.id
       WHERE c.deleted_at IS NULL
         AND (
           $1::timestamptz IS NULL
           OR (c.updated_at, c.id) < ($1::timestamptz, $2::uuid)
         )
       GROUP BY c.id
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT $3`,
      [
        options.cursor?.timestamp.toISOString() ?? null,
        options.cursor?.id ?? null,
        options.limit,
      ],
    );
    return result.rows.map(chatSummary);
  }

  async getChatMonitoringState(
    providerChatId: string,
  ): Promise<boolean | null> {
    const result = await this.pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM chats
       WHERE provider = 'bluebubbles' AND provider_chat_id = $1`,
      [providerChatId],
    );
    return result.rows[0]?.enabled ?? null;
  }

  async setChatMonitoring(input: {
    chatId: string;
    enabled: boolean;
    expectedVersion: number;
  }): Promise<ChatMonitoringMutation> {
    const updated = await this.pool.query<{ id: string }>(
      `UPDATE chats SET
         enabled = $3,
         version = version + 1,
         updated_at = NOW()
       WHERE id = $1
         AND version = $2
         AND deleted_at IS NULL
       RETURNING id`,
      [input.chatId, input.expectedVersion, input.enabled],
    );
    if (updated.rowCount === 0) {
      const exists = await this.pool.query(
        "SELECT 1 FROM chats WHERE id = $1 AND deleted_at IS NULL",
        [input.chatId],
      );
      return { status: exists.rowCount === 0 ? "not-found" : "conflict" };
    }
    const chat = await this.readChatSummary(input.chatId);
    if (chat === null) {
      return { status: "not-found" };
    }
    return { status: "ok", value: chat };
  }

  async deleteChat(input: {
    chatId: string;
    expectedVersion: number;
  }): Promise<ChatDeletionMutation> {
    const deleted = await this.pool.query<{ id: string }>(
      `UPDATE chats
       SET deleted_at = NOW(),
           version = version + 1,
           updated_at = NOW()
       WHERE id = $1
         AND version = $2
         AND enabled = FALSE
         AND deleted_at IS NULL
       RETURNING id`,
      [input.chatId, input.expectedVersion],
    );
    if ((deleted.rowCount ?? 0) > 0) {
      return { status: "deleted" };
    }

    const existing = await this.pool.query<{
      enabled: boolean;
      deleted_at: Date | null;
    }>("SELECT enabled, deleted_at FROM chats WHERE id = $1", [input.chatId]);
    const row = existing.rows[0];
    if (row === undefined || row.deleted_at !== null) {
      return { status: "not-found" };
    }
    if (row.enabled) {
      return { status: "still-enabled" };
    }
    return { status: "conflict" };
  }

  getChatParticipants(
    chatId: string,
  ): Promise<ChatParticipantIdentitySet | null> {
    return this.readChatParticipants(this.pool, chatId);
  }

  async saveChatParticipantIdentities(input: {
    chatId: string;
    expectedVersion: number;
    identities: readonly ChatParticipantIdentity[];
  }): Promise<ChatParticipantIdentityMutation> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const chat = await client.query<{ participant_identity_version: number }>(
        `SELECT participant_identity_version
         FROM chats WHERE id = $1 FOR UPDATE`,
        [input.chatId],
      );
      const currentVersion = chat.rows[0]?.participant_identity_version;
      if (currentVersion === undefined) {
        await client.query("ROLLBACK");
        return { status: "not-found" };
      }
      if (currentVersion !== input.expectedVersion) {
        await client.query("ROLLBACK");
        return { status: "conflict" };
      }

      const submittedIds = input.identities.map(
        (identity) => identity.senderId,
      );
      const uniqueSubmittedIds = new Set(submittedIds);
      const discovered =
        submittedIds.length === 0
          ? new Set<string>()
          : new Set(
              (
                await client.query<{ sender_id: string }>(
                  `SELECT DISTINCT sender_id
                   FROM messages
                   WHERE chat_id = $1
                     AND is_from_me = FALSE
                     AND sender_id = ANY($2::text[])`,
                  [input.chatId, submittedIds],
                )
              ).rows.map((row) => row.sender_id),
            );
      const invalidSenderIds = [
        ...new Set(
          submittedIds.filter(
            (senderId) =>
              !discovered.has(senderId) ||
              submittedIds.indexOf(senderId) !==
                submittedIds.lastIndexOf(senderId),
          ),
        ),
      ];
      if (
        invalidSenderIds.length > 0 ||
        uniqueSubmittedIds.size !== submittedIds.length
      ) {
        await client.query("ROLLBACK");
        return { status: "invalid-sender", senderIds: invalidSenderIds };
      }

      await client.query(
        "DELETE FROM chat_participant_identities WHERE chat_id = $1",
        [input.chatId],
      );
      for (const identity of input.identities) {
        await client.query(
          `INSERT INTO chat_participant_identities (
             id, chat_id, sender_id, real_name, nickname
           ) VALUES ($1, $2, $3, $4, $5)`,
          [
            randomUUID(),
            input.chatId,
            identity.senderId,
            identity.realName,
            identity.nickname,
          ],
        );
      }
      await client.query(
        `UPDATE chats
         SET participant_identity_version = participant_identity_version + 1
         WHERE id = $1`,
        [input.chatId],
      );
      const value = await this.readChatParticipants(client, input.chatId);
      if (value === null) {
        throw new Error("The updated chat participant mapping disappeared.");
      }
      await client.query("COMMIT");
      return { status: "ok", value };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveParticipantIdentities(
    providerChatId: string,
    senderIds: readonly string[],
  ): Promise<readonly ChatParticipantIdentity[]> {
    if (senderIds.length === 0) return [];
    const result = await this.pool.query<ParticipantIdentityRow>(
      `SELECT i.sender_id, i.real_name, i.nickname
       FROM chat_participant_identities i
       INNER JOIN chats c ON c.id = i.chat_id
       WHERE c.provider = 'bluebubbles'
         AND c.provider_chat_id = $1
         AND i.sender_id = ANY($2::text[])
       ORDER BY i.sender_id`,
      [providerChatId, [...new Set(senderIds)]],
    );
    return result.rows.map(participantIdentity);
  }

  async listMessages(
    chatId: string,
    options: PageOptions,
  ): Promise<readonly ArchivedMessage[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT
         m.id, m.provider_message_id, m.sender_id, m.sent_at, m.body, m.content_type,
         m.is_from_me, m.attachments, m.link_preview_status, m.link_previews,
         m.link_preview_error_code, m.link_preview_diagnostics,
         m.link_preview_fetched_at, m.content_redacted_at, m.created_at
       FROM messages m
       INNER JOIN chats c ON c.id = m.chat_id
       WHERE m.chat_id = $1
         AND c.enabled = TRUE
         AND (
           $2::timestamptz IS NULL
           OR (m.sent_at, m.id) < ($2::timestamptz, $3::uuid)
         )
       ORDER BY m.sent_at DESC, m.id DESC
       LIMIT $4`,
      [
        chatId,
        options.cursor?.timestamp.toISOString() ?? null,
        options.cursor?.id ?? null,
        options.limit,
      ],
    );

    return result.rows.map(archivedMessage);
  }

  async searchMessages(
    options: MessageSearchOptions,
  ): Promise<readonly MessageSearchResult[]> {
    const result = await this.pool.query<MessageSearchRow>(
      `SELECT
         m.id, m.provider_message_id, m.sender_id, m.sent_at, m.body,
         m.content_type, m.is_from_me, m.attachments, m.content_redacted_at,
         m.created_at, m.link_preview_status, m.link_previews,
         m.link_preview_error_code, m.link_preview_diagnostics,
         m.link_preview_fetched_at,
         c.id AS chat_id, c.provider_chat_id,
         c.display_name AS chat_display_name
       FROM messages m
       INNER JOIN chats c ON c.id = m.chat_id
       WHERE c.enabled = TRUE
         AND ($1::uuid IS NULL OR c.id = $1)
         AND (
           $2::text IS NULL
           OR POSITION(LOWER($2) IN LOWER(COALESCE(m.body, ''))) > 0
         )
         AND ($3::text IS NULL OR m.sender_id = $3)
         AND ($4::timestamptz IS NULL OR m.sent_at >= $4)
         AND ($5::timestamptz IS NULL OR m.sent_at <= $5)
         AND (
           $6::timestamptz IS NULL
           OR (m.sent_at, m.id) < ($6::timestamptz, $7::uuid)
         )
       ORDER BY m.sent_at DESC, m.id DESC
       LIMIT $8`,
      [
        options.chatId,
        options.keyword,
        options.senderId,
        options.sentFrom?.toISOString() ?? null,
        options.sentTo?.toISOString() ?? null,
        options.cursor?.timestamp.toISOString() ?? null,
        options.cursor?.id ?? null,
        options.limit,
      ],
    );
    return result.rows.map((row) => ({
      ...archivedMessage(row),
      chatId: row.chat_id,
      providerChatId: row.provider_chat_id,
      chatDisplayName: row.chat_display_name,
    }));
  }

  async findMessage(messageId: string): Promise<ArchivedMessage | null> {
    const result = await this.pool.query<MessageRow>(
      `SELECT
         m.id, m.provider_message_id, m.sender_id, m.sent_at, m.body,
         m.content_type, m.is_from_me, m.attachments, m.link_preview_status,
         m.link_previews, m.link_preview_error_code,
         m.link_preview_diagnostics, m.link_preview_fetched_at,
         m.content_redacted_at, m.created_at
       FROM messages m
       INNER JOIN chats c ON c.id = m.chat_id
       WHERE m.id = $1 AND c.enabled = TRUE`,
      [messageId],
    );
    const row = result.rows[0];
    return row === undefined ? null : archivedMessage(row);
  }

  async loadRecentMessages(
    providerChatId: string,
    options: ContextWindowOptions,
  ): Promise<readonly ContextMessage[]> {
    const result = await this.pool.query<ContextMessageRow>(
      `SELECT message_index::text, provider_message_id, sender_id, sent_at, body, is_from_me, attachments,
              link_preview_status, link_previews, link_preview_error_code
       FROM (
         SELECT m.message_index, m.provider_message_id, m.sender_id, m.sent_at,
                LEFT(COALESCE(m.body, ''), $5) AS body,
                m.is_from_me, m.id, m.attachments, m.link_preview_status, m.link_previews,
                m.link_preview_error_code
         FROM messages m
         INNER JOIN chats c ON c.id = m.chat_id
         WHERE c.provider = 'bluebubbles'
           AND c.provider_chat_id = $1
           AND c.enabled = TRUE
           AND ((m.body IS NOT NULL AND m.body <> '')
                OR m.link_preview_status = 'available'
                OR m.attachments <> '[]'::jsonb)
           AND ($2::boolean OR m.is_from_me = FALSE)
           AND m.message_index < (
             SELECT boundary.message_index FROM messages boundary
             WHERE boundary.provider = 'bluebubbles'
               AND boundary.provider_message_id = $3
           )
         ORDER BY m.message_index DESC
         LIMIT $4
       ) recent
       ORDER BY message_index`,
      [
        providerChatId,
        options.includeFromMe,
        options.beforeProviderMessageId,
        options.limit,
        options.maxCharacters,
      ],
    );
    const selected: ContextMessage[] = [];
    let characters = 0;
    for (const row of result.rows.reverse()) {
      const linkPreview = linkPreviewBundle(row);
      const previewCharacters = linkPreview.items.reduce(
        (total, item) =>
          total +
          item.url.length +
          (item.title?.length ?? 0) +
          (item.summary?.length ?? 0) +
          (item.siteName?.length ?? 0),
        0,
      );
      if (
        characters + row.body.length + previewCharacters >
        options.maxCharacters
      ) {
        continue;
      }
      characters += row.body.length + previewCharacters;
      selected.push({
        providerMessageId: row.provider_message_id,
        senderId: row.sender_id,
        sentAt: row.sent_at.toISOString(),
        body: row.body,
        isFromMe: row.is_from_me,
        attachments: messageAttachments(row.attachments),
        linkPreview,
      });
    }
    return selected.reverse();
  }

  async redactExpiredMessageContent(
    input: MessageRetentionBatchInput,
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtext('bubblepilot-message-content')) AS acquired",
      );
      if (lock.rows[0]?.acquired !== true) {
        await client.query("ROLLBACK");
        return 0;
      }
      const redacted = await client.query<{
        id: string;
        chat_id: string;
      }>(
        `WITH candidates AS (
           SELECT m.id
           FROM messages m
           INNER JOIN inbound_events i ON i.id = m.source_event_id
           WHERE m.content_redacted_at IS NULL
             AND m.created_at < $1
             AND i.automation_outcome <> 'evaluation-pending'
             AND NOT EXISTS (
               SELECT 1
               FROM workflow_executions e
               WHERE e.source_message_id = m.id
                 AND (
                   e.status IN ('created', 'running', 'retrying')
                   OR (
                     e.status IN ('failed', 'dead-lettered')
                     AND NOT EXISTS (
                       SELECT 1
                       FROM workflow_executions recovery
                       WHERE recovery.retry_of_execution_id = e.id
                     )
                   )
                 )
             )
             AND NOT EXISTS (
               SELECT 1
               FROM data_export_jobs j
               WHERE j.chat_id = m.chat_id
                 AND j.include_messages = TRUE
                 AND j.status IN ('awaiting-confirmation', 'ready')
                 AND j.expires_at > $2
                 AND m.sent_at >= j.sent_from
                 AND m.sent_at <= j.sent_to
                 AND m.created_at <= j.snapshot_at
             )
           ORDER BY m.created_at, m.id
           LIMIT $3
           FOR UPDATE OF m SKIP LOCKED
         )
         UPDATE messages m
         SET body = NULL,
             attachments = '[]'::jsonb,
             link_preview_status = 'redacted',
             link_previews = '[]'::jsonb,
             link_preview_error_code = NULL,
             content_redacted_at = $2
         FROM candidates c
         WHERE m.id = c.id
         RETURNING m.id, m.chat_id`,
        [input.before, input.now, input.limit],
      );
      const redactedCount = redacted.rowCount ?? 0;
      if (redactedCount > 0) {
        const messageIds = redacted.rows.map((message) => message.id);
        await client.query(
          `UPDATE message_image_summaries
           SET status = 'redacted', source_key = 'redacted:' || id::text,
               summary = NULL, image_content_hash = NULL,
               provider_id = NULL, provider_name = NULL, model = NULL,
               error_code = 'IMAGE_SUMMARY_REDACTED_BY_RETENTION',
               lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
           WHERE message_id = ANY($1::uuid[])`,
          [messageIds],
        );
        const chatIds = [
          ...new Set(redacted.rows.map((message) => message.chat_id)),
        ];
        const ended = await client.query<{ id: string }>(
          `UPDATE conversation_context_compressions operation
           SET status = 'failed',
               error_code = 'CONTEXT_SUMMARY_REDACTED_BY_RETENTION',
               completed_at = NOW(), lease_owner = NULL, updated_at = NOW()
           FROM conversation_context_states state
           WHERE operation.context_state_id = state.id
             AND state.chat_id = ANY($1::uuid[])
             AND operation.status IN ('queued', 'running')
           RETURNING operation.id`,
          [chatIds],
        );
        for (const operation of ended.rows) {
          await client.query(
            `INSERT INTO conversation_context_compression_events
               (id, compression_id, status, error_code, metadata)
             VALUES ($1, $2, 'failed', $3, $4::jsonb)`,
            [
              randomUUID(),
              operation.id,
              "CONTEXT_SUMMARY_REDACTED_BY_RETENTION",
              JSON.stringify({ source: "message-retention" }),
            ],
          );
        }
        await client.query(
          `WITH reset AS (
             UPDATE conversation_context_states
             SET summary = '', covered_through_index = 0,
                 version = version + 1, status = 'idle', updated_at = NOW(),
                 last_error_code = 'CONTEXT_SUMMARY_REDACTED_BY_RETENTION'
             WHERE chat_id = ANY($1::uuid[])
             RETURNING id, version, summary, covered_through_index
           )
           INSERT INTO conversation_context_summary_revisions
             (context_state_id, version, summary, covered_through_index)
           SELECT id, version, summary, covered_through_index FROM reset
           ON CONFLICT (context_state_id, version) DO NOTHING`,
          [chatIds],
        );
        await client.query(
          `INSERT INTO audit_events (
             id, actor_type, actor_session_id, action, target_type, target_id,
             outcome, correlation_id, metadata
           ) VALUES (
             $1, 'system', NULL, 'message.content.retention',
             'message-content', NULL, 'succeeded', $2, $3::jsonb
           )`,
          [
            randomUUID(),
            input.correlationId,
            JSON.stringify({
              retentionDays: input.retentionDays,
              cutoffAt: input.before.toISOString(),
              redactedCount,
            }),
          ],
        );
      }
      await client.query("COMMIT");
      return redactedCount;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async isReady(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ ready: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM schema_migrations
           WHERE name = '0023_message_link_previews.sql'
         ) AS ready`,
      );
      return result.rows[0]?.ready === true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private claimEvent(
    client: PoolClient,
    event: {
      id: string;
      provider: string;
      externalEventId: string;
      correlationId: string;
      eventType: string;
      payloadHash: string;
    },
  ): Promise<QueryResult<ClaimedEventRow>> {
    return client.query<ClaimedEventRow>(
      `INSERT INTO inbound_events (
         id, provider, external_event_id, correlation_id, event_type, status,
         payload_hash, automation_outcome
       ) VALUES ($1, $2, $3, $4, $5, 'accepted', $6, 'evaluation-pending')
       ON CONFLICT (provider, external_event_id) DO UPDATE SET
         correlation_id = EXCLUDED.correlation_id,
         received_at = NOW(),
         status = 'accepted',
         payload_hash = EXCLUDED.payload_hash,
         automation_outcome = 'evaluation-pending',
         error_code = NULL,
         error_summary = NULL
       WHERE inbound_events.status = 'failed'
       RETURNING id, automation_outcome`,
      [
        event.id,
        event.provider,
        event.externalEventId,
        event.correlationId,
        event.eventType,
        event.payloadHash,
      ],
    );
  }

  private async readAutomationOutcome(
    queryable: Pool | PoolClient,
    provider: string,
    eventId: string,
  ): Promise<AutomationOutcome> {
    const result = await queryable.query<{
      automation_outcome: AutomationOutcome;
    }>(
      `SELECT automation_outcome
       FROM inbound_events
       WHERE provider = $1 AND external_event_id = $2`,
      [provider, eventId],
    );
    const outcome = result.rows[0]?.automation_outcome;
    if (outcome === undefined) {
      throw new Error("The inbound event does not exist.");
    }
    return outcome;
  }

  private async readChatSummary(chatId: string): Promise<ChatSummary | null> {
    const result = await this.pool.query<ChatRow>(
      `SELECT
         c.id, c.provider_chat_id, c.type, c.display_name, c.enabled, c.version,
         c.updated_at, COUNT(m.id)::text AS message_count
       FROM chats c
       LEFT JOIN messages m ON m.chat_id = c.id
       WHERE c.id = $1
       GROUP BY c.id`,
      [chatId],
    );
    const row = result.rows[0];
    return row === undefined ? null : chatSummary(row);
  }

  private async readChatParticipants(
    queryable: Pool | PoolClient,
    chatId: string,
  ): Promise<ChatParticipantIdentitySet | null> {
    const chat = await queryable.query<{
      participant_identity_version: number;
    }>(`SELECT participant_identity_version FROM chats WHERE id = $1`, [
      chatId,
    ]);
    const version = chat.rows[0]?.participant_identity_version;
    if (version === undefined) return null;
    const participants = await queryable.query<ChatParticipantRow>(
      `SELECT
         m.sender_id, i.real_name, i.nickname,
         COUNT(m.id)::text AS message_count,
         MAX(m.sent_at) AS last_seen_at
       FROM messages m
       LEFT JOIN chat_participant_identities i
         ON i.chat_id = m.chat_id AND i.sender_id = m.sender_id
       WHERE m.chat_id = $1
         AND m.is_from_me = FALSE
         AND m.sender_id IS NOT NULL
         AND m.sender_id <> ''
       GROUP BY m.sender_id, i.real_name, i.nickname
       ORDER BY MAX(m.sent_at) DESC, m.sender_id`,
      [chatId],
    );
    return {
      chatId,
      version,
      participants: participants.rows.map(participantView),
    };
  }

  private async recordFailure(
    envelope: MessageEnvelope,
    error: unknown,
  ): Promise<void> {
    const summary =
      error instanceof Error
        ? error.message.slice(0, 500)
        : "Unknown ingestion error";
    try {
      await this.pool.query(
        `INSERT INTO inbound_events (
           id, provider, external_event_id, correlation_id, event_type, status,
           payload_hash, error_code, error_summary, automation_outcome
         ) VALUES (
           $1, $2, $3, $4, $5, 'failed', $6, 'INGESTION_FAILED', $7,
           'not-evaluated'
         )
         ON CONFLICT (provider, external_event_id) DO UPDATE SET
           correlation_id = EXCLUDED.correlation_id,
           received_at = NOW(),
           status = 'failed',
           automation_outcome = 'not-evaluated',
           error_code = EXCLUDED.error_code,
           error_summary = EXCLUDED.error_summary`,
        [
          randomUUID(),
          envelope.provider,
          envelope.eventId,
          envelope.correlationId,
          envelope.metadata.eventType,
          envelope.metadata.payloadHash,
          summary,
        ],
      );
    } catch {
      // The original storage error is more useful to the caller than a best-effort failure record error.
    }
  }
}
