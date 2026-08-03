import { randomUUID } from "node:crypto";

import { Pool, type PoolClient, type QueryResult } from "pg";

import type {
  ArchiveRepository,
  ArchivedMessage,
  ChatSummary,
  IngestionResult,
  PageOptions,
} from "./archive-repository.js";
import type {
  IgnoredInboundEvent,
  MessageEnvelope,
} from "../ingestion/message-envelope.js";

interface IdentifierRow {
  id: string;
}

interface ChatRow {
  id: string;
  provider_chat_id: string;
  type: "direct" | "group" | "unknown";
  display_name: string | null;
  enabled: boolean;
  message_count: string;
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
  created_at: Date;
}

export class PostgresArchiveRepository implements ArchiveRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
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
        await client.query("ROLLBACK");
        return {
          status: "duplicate",
          eventId: envelope.eventId,
          correlationId: envelope.correlationId,
          messageId: null,
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
           enabled = EXCLUDED.enabled,
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
          "UPDATE inbound_events SET status = 'ignored' WHERE id = $1",
          [eventId],
        );
        await client.query("COMMIT");
        return {
          status: "ignored",
          eventId: envelope.eventId,
          correlationId: envelope.correlationId,
          messageId: null,
        };
      }

      const messageId = randomUUID();
      const message = await client.query<IdentifierRow>(
        `INSERT INTO messages (
           id, provider, provider_message_id, chat_id, sender_id, sent_at, body,
           content_type, is_from_me, content_hash, attachments, source_event_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
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
        ],
      );

      await client.query(
        "UPDATE inbound_events SET status = 'completed' WHERE id = $1",
        [eventId],
      );
      await client.query("COMMIT");

      const persistedMessageId = message.rows[0]?.id ?? null;
      return {
        status: persistedMessageId === null ? "duplicate" : "archived",
        eventId: envelope.eventId,
        correlationId: envelope.correlationId,
        messageId: persistedMessageId,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      await this.recordFailure(envelope, error);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordIgnoredEvent(
    event: IgnoredInboundEvent,
  ): Promise<IngestionResult> {
    const result = await this.pool.query<IdentifierRow>(
      `INSERT INTO inbound_events (
         id, provider, external_event_id, correlation_id, event_type, status, payload_hash, error_code
       ) VALUES ($1, $2, $3, $4, $5, 'ignored', $6, $7)
       ON CONFLICT (provider, external_event_id) DO NOTHING
       RETURNING id`,
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

    return {
      status: result.rowCount === 0 ? "duplicate" : "ignored",
      eventId: event.eventId,
      correlationId: event.correlationId,
      messageId: null,
    };
  }

  async listChats(options: PageOptions): Promise<readonly ChatSummary[]> {
    const result = await this.pool.query<ChatRow>(
      `SELECT
         c.id, c.provider_chat_id, c.type, c.display_name, c.enabled, c.updated_at,
         COUNT(m.id)::text AS message_count
       FROM chats c
       LEFT JOIN messages m ON m.chat_id = c.id
       WHERE c.enabled = TRUE
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

    return result.rows.map((row) => ({
      id: row.id,
      providerChatId: row.provider_chat_id,
      type: row.type,
      displayName: row.display_name,
      enabled: row.enabled,
      messageCount: Number(row.message_count),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async listMessages(
    chatId: string,
    options: PageOptions,
  ): Promise<readonly ArchivedMessage[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT
         m.id, m.provider_message_id, m.sender_id, m.sent_at, m.body, m.content_type,
         m.is_from_me, m.attachments, m.created_at
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

    return result.rows.map((row) => ({
      id: row.id,
      providerMessageId: row.provider_message_id,
      senderId: row.sender_id,
      sentAt: row.sent_at.toISOString(),
      body: row.body,
      contentType: row.content_type,
      isFromMe: row.is_from_me,
      attachments: row.attachments,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async isReady(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ ready: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM schema_migrations WHERE name = '0001_message_ingestion.sql'
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
  ): Promise<QueryResult<IdentifierRow>> {
    return client.query<IdentifierRow>(
      `INSERT INTO inbound_events (
         id, provider, external_event_id, correlation_id, event_type, status, payload_hash
       ) VALUES ($1, $2, $3, $4, $5, 'accepted', $6)
       ON CONFLICT (provider, external_event_id) DO UPDATE SET
         correlation_id = EXCLUDED.correlation_id,
         received_at = NOW(),
         status = 'accepted',
         payload_hash = EXCLUDED.payload_hash,
         error_code = NULL,
         error_summary = NULL
       WHERE inbound_events.status = 'failed'
       RETURNING id`,
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
           payload_hash, error_code, error_summary
         ) VALUES ($1, $2, $3, $4, $5, 'failed', $6, 'INGESTION_FAILED', $7)
         ON CONFLICT (provider, external_event_id) DO UPDATE SET
           correlation_id = EXCLUDED.correlation_id,
           received_at = NOW(),
           status = 'failed',
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
