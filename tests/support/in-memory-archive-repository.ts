import { randomUUID } from "node:crypto";

import type {
  ArchiveRepository,
  ArchivedMessage,
  ChatSummary,
  IngestionResult,
  PageOptions,
} from "../../modules/archive/archive-repository.js";
import type {
  IgnoredInboundEvent,
  MessageEnvelope,
} from "../../modules/ingestion/message-envelope.js";

interface StoredChat extends ChatSummary {
  messages: ArchivedMessage[];
}

export class InMemoryArchiveRepository implements ArchiveRepository {
  readonly events = new Set<string>();
  readonly chats = new Map<string, StoredChat>();

  async ingestMessage(
    envelope: MessageEnvelope,
    archiveEnabled: boolean,
  ): Promise<IngestionResult> {
    if (this.events.has(envelope.eventId)) {
      return {
        status: "duplicate",
        eventId: envelope.eventId,
        correlationId: envelope.correlationId,
        messageId: null,
      };
    }
    this.events.add(envelope.eventId);

    const existing = this.chats.get(envelope.chat.providerChatId);
    const now = new Date().toISOString();
    const chat: StoredChat = existing ?? {
      id: randomUUID(),
      providerChatId: envelope.chat.providerChatId,
      type: envelope.chat.type,
      displayName: envelope.chat.displayName,
      enabled: archiveEnabled,
      messageCount: 0,
      updatedAt: now,
      messages: [],
    };
    chat.enabled = archiveEnabled;
    chat.updatedAt = now;
    this.chats.set(envelope.chat.providerChatId, chat);

    if (!archiveEnabled) {
      return {
        status: "ignored",
        eventId: envelope.eventId,
        correlationId: envelope.correlationId,
        messageId: null,
      };
    }

    const duplicateMessage = [...this.chats.values()].some((candidate) =>
      candidate.messages.some(
        (message) =>
          message.providerMessageId === envelope.message.providerMessageId,
      ),
    );
    if (duplicateMessage) {
      return {
        status: "duplicate",
        eventId: envelope.eventId,
        correlationId: envelope.correlationId,
        messageId: null,
      };
    }

    const message: ArchivedMessage = {
      id: randomUUID(),
      providerMessageId: envelope.message.providerMessageId,
      senderId: envelope.message.senderId,
      sentAt: envelope.message.sentAt,
      body: envelope.message.text,
      contentType: envelope.message.contentType,
      isFromMe: envelope.message.isFromMe,
      attachments: envelope.message.attachments,
      createdAt: now,
    };
    chat.messages.push(message);
    chat.messageCount = chat.messages.length;
    return {
      status: "archived",
      eventId: envelope.eventId,
      correlationId: envelope.correlationId,
      messageId: message.id,
    };
  }

  async recordIgnoredEvent(
    event: IgnoredInboundEvent,
  ): Promise<IngestionResult> {
    const duplicate = this.events.has(event.eventId);
    this.events.add(event.eventId);
    return {
      status: duplicate ? "duplicate" : "ignored",
      eventId: event.eventId,
      correlationId: event.correlationId,
      messageId: null,
    };
  }

  async listChats(options: PageOptions): Promise<readonly ChatSummary[]> {
    return [...this.chats.values()]
      .filter(
        (chat) =>
          chat.enabled && this.isBefore(chat.updatedAt, chat.id, options),
      )
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, options.limit)
      .map((chat) => ({
        id: chat.id,
        providerChatId: chat.providerChatId,
        type: chat.type,
        displayName: chat.displayName,
        enabled: chat.enabled,
        messageCount: chat.messageCount,
        updatedAt: chat.updatedAt,
      }));
  }

  async listMessages(
    chatId: string,
    options: PageOptions,
  ): Promise<readonly ArchivedMessage[]> {
    const chat = [...this.chats.values()].find(
      (candidate) => candidate.id === chatId,
    );
    if (chat === undefined || !chat.enabled) {
      return [];
    }

    return chat.messages
      .filter((message) => this.isBefore(message.sentAt, message.id, options))
      .sort(
        (left, right) =>
          right.sentAt.localeCompare(left.sentAt) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, options.limit);
  }

  async isReady(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}

  private isBefore(
    timestamp: string,
    id: string,
    options: PageOptions,
  ): boolean {
    if (options.cursor === null) {
      return true;
    }
    const cursorTimestamp = options.cursor.timestamp.toISOString();
    return (
      timestamp < cursorTimestamp ||
      (timestamp === cursorTimestamp && id < options.cursor.id)
    );
  }
}
