import { randomUUID } from "node:crypto";

import type {
  ArchiveRepository,
  ArchivedMessage,
  AutomationOutcome,
  ChatDeletionMutation,
  ChatMonitoringMutation,
  ChatParticipantIdentity,
  ChatParticipantIdentityMutation,
  ChatParticipantIdentitySet,
  ChatSummary,
  ContextMessage,
  ContextWindowOptions,
  InboundEventSummary,
  IngestionResult,
  MessageSearchOptions,
  MessageSearchResult,
  MessageRetentionBatchInput,
  PageOptions,
} from "../../modules/archive/archive-repository.js";
import type {
  IgnoredInboundEvent,
  MessageEnvelope,
} from "../../modules/ingestion/message-envelope.js";
import type {
  LinkPreviewBundle,
  LinkPreviewDiagnostic,
} from "../../modules/ingestion/link-preview.js";

interface StoredChat extends ChatSummary {
  deletedAt: string | null;
  messages: ArchivedMessage[];
  participantIdentityVersion: number;
  participantIdentities: Map<string, ChatParticipantIdentity>;
}

export class InMemoryArchiveRepository implements ArchiveRepository {
  readonly events = new Map<string, InboundEventSummary>();
  readonly chats = new Map<string, StoredChat>();

  async ingestMessage(
    envelope: MessageEnvelope,
    archiveEnabled: boolean,
  ): Promise<IngestionResult> {
    const existingEvent = this.events.get(envelope.eventId);
    if (existingEvent !== undefined) {
      return {
        status: "duplicate",
        eventId: envelope.eventId,
        correlationId: envelope.correlationId,
        messageId: null,
        automationOutcome: existingEvent.automationOutcome,
      };
    }
    const receivedAt = new Date().toISOString();
    this.events.set(envelope.eventId, {
      id: randomUUID(),
      provider: envelope.provider,
      eventId: envelope.eventId,
      correlationId: envelope.correlationId,
      eventType: envelope.metadata.eventType,
      ingestionStatus: archiveEnabled ? "completed" : "ignored",
      automationOutcome: archiveEnabled
        ? "evaluation-pending"
        : "chat-not-monitored",
      receivedAt,
    });

    const existing = this.chats.get(envelope.chat.providerChatId);
    const now = receivedAt;
    const chat: StoredChat = existing ?? {
      id: randomUUID(),
      providerChatId: envelope.chat.providerChatId,
      type: envelope.chat.type,
      displayName: envelope.chat.displayName,
      enabled: archiveEnabled,
      messageCount: 0,
      version: 1,
      updatedAt: now,
      deletedAt: null,
      messages: [],
      participantIdentityVersion: 1,
      participantIdentities: new Map(),
    };
    chat.deletedAt = null;
    chat.updatedAt = now;
    this.chats.set(envelope.chat.providerChatId, chat);

    if (!archiveEnabled) {
      return {
        status: "ignored",
        eventId: envelope.eventId,
        correlationId: envelope.correlationId,
        messageId: null,
        automationOutcome: "chat-not-monitored",
      };
    }

    const duplicateMessage = [...this.chats.values()].some((candidate) =>
      candidate.messages.some(
        (message) =>
          message.providerMessageId === envelope.message.providerMessageId,
      ),
    );
    if (duplicateMessage) {
      const event = this.events.get(envelope.eventId);
      if (event !== undefined) event.automationOutcome = "not-evaluated";
      return {
        status: "duplicate",
        eventId: envelope.eventId,
        correlationId: envelope.correlationId,
        messageId: null,
        automationOutcome: "not-evaluated",
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
      linkPreview: envelope.message.linkPreview,
      linkPreviewDiagnostics: [],
      linkPreviewFetchedAt: null,
      contentRedactedAt: null,
      createdAt: now,
    };
    chat.messages.push(message);
    chat.messageCount = chat.messages.length;
    return {
      status: "archived",
      eventId: envelope.eventId,
      correlationId: envelope.correlationId,
      messageId: message.id,
      automationOutcome: "evaluation-pending",
    };
  }

  saveMessageLinkPreview(input: {
    providerMessageId: string;
    linkPreview: LinkPreviewBundle;
    diagnostics: readonly LinkPreviewDiagnostic[];
    fetchedAt: Date;
  }): Promise<LinkPreviewBundle | null> {
    const message = [...this.chats.values()]
      .flatMap((chat) => chat.messages)
      .find((item) => item.providerMessageId === input.providerMessageId);
    if (message === undefined) return Promise.resolve(null);
    if (message.linkPreview.status !== "pending")
      return Promise.resolve(message.linkPreview);
    message.linkPreview = input.linkPreview;
    message.linkPreviewDiagnostics = input.diagnostics;
    message.linkPreviewFetchedAt = input.fetchedAt.toISOString();
    return Promise.resolve(input.linkPreview);
  }

  async recordIgnoredEvent(
    event: IgnoredInboundEvent,
  ): Promise<IngestionResult> {
    const existingEvent = this.events.get(event.eventId);
    if (existingEvent === undefined) {
      this.events.set(event.eventId, {
        id: randomUUID(),
        provider: event.provider,
        eventId: event.eventId,
        correlationId: event.correlationId,
        eventType: event.eventType,
        ingestionStatus: "ignored",
        automationOutcome: "unsupported-event",
        receivedAt: new Date().toISOString(),
      });
    }
    return {
      status: existingEvent === undefined ? "ignored" : "duplicate",
      eventId: event.eventId,
      correlationId: event.correlationId,
      messageId: null,
      automationOutcome:
        existingEvent?.automationOutcome ?? "unsupported-event",
    };
  }

  recordAutomationOutcome(
    _provider: string,
    eventId: string,
    outcome: AutomationOutcome,
  ): Promise<AutomationOutcome> {
    const event = this.events.get(eventId);
    if (event === undefined) {
      throw new Error("The inbound event does not exist.");
    }
    if (event.automationOutcome === "evaluation-pending") {
      event.automationOutcome = outcome;
    }
    return Promise.resolve(event.automationOutcome);
  }

  listInboundEvents(
    options: PageOptions,
  ): Promise<readonly InboundEventSummary[]> {
    return Promise.resolve(
      [...this.events.values()]
        .filter((event) => this.isBefore(event.receivedAt, event.id, options))
        .sort(
          (left, right) =>
            right.receivedAt.localeCompare(left.receivedAt) ||
            right.id.localeCompare(left.id),
        )
        .slice(0, options.limit)
        .map((event) => ({ ...event })),
    );
  }

  async listChats(options: PageOptions): Promise<readonly ChatSummary[]> {
    return [...this.chats.values()]
      .filter(
        (chat) =>
          chat.enabled &&
          chat.deletedAt === null &&
          this.isBefore(chat.updatedAt, chat.id, options),
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
        version: chat.version,
        updatedAt: chat.updatedAt,
      }));
  }

  async listChatMonitoring(
    options: PageOptions,
  ): Promise<readonly ChatSummary[]> {
    return [...this.chats.values()]
      .filter(
        (chat) =>
          chat.deletedAt === null &&
          this.isBefore(chat.updatedAt, chat.id, options),
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
        version: chat.version,
        updatedAt: chat.updatedAt,
      }));
  }

  getChatMonitoringState(providerChatId: string): Promise<boolean | null> {
    return Promise.resolve(this.chats.get(providerChatId)?.enabled ?? null);
  }

  setChatMonitoring(input: {
    chatId: string;
    enabled: boolean;
    expectedVersion: number;
  }): Promise<ChatMonitoringMutation> {
    const chat = [...this.chats.values()].find(
      (candidate) => candidate.id === input.chatId,
    );
    if (chat === undefined) {
      return Promise.resolve({ status: "not-found" });
    }
    if (chat.deletedAt !== null) {
      return Promise.resolve({ status: "not-found" });
    }
    if (chat.version !== input.expectedVersion) {
      return Promise.resolve({ status: "conflict" });
    }
    chat.enabled = input.enabled;
    chat.version += 1;
    chat.updatedAt = new Date().toISOString();
    return Promise.resolve({
      status: "ok",
      value: {
        id: chat.id,
        providerChatId: chat.providerChatId,
        type: chat.type,
        displayName: chat.displayName,
        enabled: chat.enabled,
        messageCount: chat.messageCount,
        version: chat.version,
        updatedAt: chat.updatedAt,
      },
    });
  }

  deleteChat(input: {
    chatId: string;
    expectedVersion: number;
  }): Promise<ChatDeletionMutation> {
    const chat = [...this.chats.values()].find(
      (candidate) => candidate.id === input.chatId,
    );
    if (chat === undefined || chat.deletedAt !== null) {
      return Promise.resolve({ status: "not-found" });
    }
    if (chat.enabled) {
      return Promise.resolve({ status: "still-enabled" });
    }
    if (chat.version !== input.expectedVersion) {
      return Promise.resolve({ status: "conflict" });
    }
    chat.deletedAt = new Date().toISOString();
    chat.version += 1;
    chat.updatedAt = chat.deletedAt;
    return Promise.resolve({ status: "deleted" });
  }

  getChatParticipants(
    chatId: string,
  ): Promise<ChatParticipantIdentitySet | null> {
    const chat = [...this.chats.values()].find(
      (candidate) => candidate.id === chatId,
    );
    if (chat === undefined) return Promise.resolve(null);
    const participantMessages = new Map<
      string,
      { messageCount: number; lastSeenAt: string }
    >();
    for (const message of chat.messages) {
      if (
        message.isFromMe ||
        message.senderId === null ||
        message.senderId === ""
      ) {
        continue;
      }
      const existing = participantMessages.get(message.senderId);
      participantMessages.set(message.senderId, {
        messageCount: (existing?.messageCount ?? 0) + 1,
        lastSeenAt:
          existing === undefined || message.sentAt > existing.lastSeenAt
            ? message.sentAt
            : existing.lastSeenAt,
      });
    }
    return Promise.resolve({
      chatId,
      version: chat.participantIdentityVersion,
      participants: [...participantMessages.entries()]
        .map(([senderId, discovered]) => ({
          senderId,
          realName: chat.participantIdentities.get(senderId)?.realName ?? null,
          nickname: chat.participantIdentities.get(senderId)?.nickname ?? null,
          ...discovered,
        }))
        .sort(
          (left, right) =>
            right.lastSeenAt.localeCompare(left.lastSeenAt) ||
            left.senderId.localeCompare(right.senderId),
        ),
    });
  }

  async saveChatParticipantIdentities(input: {
    chatId: string;
    expectedVersion: number;
    identities: readonly ChatParticipantIdentity[];
  }): Promise<ChatParticipantIdentityMutation> {
    const chat = [...this.chats.values()].find(
      (candidate) => candidate.id === input.chatId,
    );
    if (chat === undefined) return { status: "not-found" };
    if (chat.participantIdentityVersion !== input.expectedVersion) {
      return { status: "conflict" };
    }
    const discovered = new Set(
      chat.messages
        .filter(
          (message) =>
            !message.isFromMe &&
            message.senderId !== null &&
            message.senderId !== "",
        )
        .map((message) => message.senderId as string),
    );
    const senderIds = input.identities.map((identity) => identity.senderId);
    const invalidSenderIds = [
      ...new Set(
        senderIds.filter(
          (senderId) =>
            !discovered.has(senderId) ||
            senderIds.indexOf(senderId) !== senderIds.lastIndexOf(senderId),
        ),
      ),
    ];
    if (invalidSenderIds.length > 0) {
      return { status: "invalid-sender", senderIds: invalidSenderIds };
    }
    chat.participantIdentities = new Map(
      input.identities.map((identity) => [identity.senderId, { ...identity }]),
    );
    chat.participantIdentityVersion += 1;
    return {
      status: "ok",
      value: (await this.getChatParticipants(
        input.chatId,
      )) as ChatParticipantIdentitySet,
    };
  }

  resolveParticipantIdentities(
    providerChatId: string,
    senderIds: readonly string[],
  ): Promise<readonly ChatParticipantIdentity[]> {
    const identities = this.chats.get(providerChatId)?.participantIdentities;
    if (identities === undefined) return Promise.resolve([]);
    return Promise.resolve(
      [...new Set(senderIds)].flatMap((senderId) => {
        const identity = identities.get(senderId);
        return identity === undefined ? [] : [{ ...identity }];
      }),
    );
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

  searchMessages(
    options: MessageSearchOptions,
  ): Promise<readonly MessageSearchResult[]> {
    const results = [...this.chats.values()]
      .filter((chat) => chat.enabled)
      .filter((chat) => options.chatId === null || chat.id === options.chatId)
      .flatMap((chat) =>
        chat.messages.map((message) => ({
          ...message,
          chatId: chat.id,
          providerChatId: chat.providerChatId,
          chatDisplayName: chat.displayName,
        })),
      )
      .filter(
        (message) =>
          (options.keyword === null ||
            (message.body ?? "")
              .toLocaleLowerCase()
              .includes(options.keyword.toLocaleLowerCase())) &&
          (options.senderId === null ||
            message.senderId === options.senderId) &&
          (options.sentFrom === null ||
            message.sentAt >= options.sentFrom.toISOString()) &&
          (options.sentTo === null ||
            message.sentAt <= options.sentTo.toISOString()) &&
          this.isBefore(message.sentAt, message.id, options),
      )
      .sort(
        (left, right) =>
          right.sentAt.localeCompare(left.sentAt) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, options.limit);
    return Promise.resolve(results);
  }

  findMessage(messageId: string): Promise<ArchivedMessage | null> {
    const message = [...this.chats.values()]
      .filter((chat) => chat.enabled)
      .flatMap((chat) => chat.messages)
      .find((item) => item.id === messageId);
    return Promise.resolve(message ?? null);
  }

  loadRecentMessages(
    providerChatId: string,
    options: ContextWindowOptions,
  ): Promise<readonly ContextMessage[]> {
    const messages = this.chats.get(providerChatId)?.messages ?? [];
    const boundaryIndex = messages.findIndex(
      (message) =>
        message.providerMessageId === options.beforeProviderMessageId,
    );
    if (boundaryIndex < 0) return Promise.resolve([]);
    const selected: ContextMessage[] = [];
    let characters = 0;
    for (const message of messages.slice(0, boundaryIndex).reverse()) {
      const previewCharacters = message.linkPreview.items.reduce(
        (total, item) =>
          total +
          item.url.length +
          (item.title?.length ?? 0) +
          (item.summary?.length ?? 0) +
          (item.siteName?.length ?? 0),
        0,
      );
      if (
        ((message.body === null || message.body.length === 0) &&
          message.linkPreview.status !== "available") ||
        (!options.includeFromMe && message.isFromMe) ||
        selected.length >= options.limit ||
        characters + (message.body?.length ?? 0) + previewCharacters >
          options.maxCharacters
      ) {
        continue;
      }
      characters += (message.body?.length ?? 0) + previewCharacters;
      selected.push({
        providerMessageId: message.providerMessageId,
        senderId: message.senderId,
        sentAt: message.sentAt,
        body: message.body ?? "",
        isFromMe: message.isFromMe,
        attachments: message.attachments,
        linkPreview: message.linkPreview,
      });
    }
    return Promise.resolve(selected.reverse());
  }

  redactExpiredMessageContent(
    input: MessageRetentionBatchInput,
  ): Promise<number> {
    const candidates = [...this.chats.values()]
      .flatMap((chat) => chat.messages)
      .filter(
        (message) =>
          message.contentRedactedAt === null &&
          message.createdAt < input.before.toISOString(),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, input.limit);
    for (const message of candidates) {
      message.body = null;
      message.attachments = [];
      message.linkPreview = {
        status: "redacted",
        errorCode: null,
        items: [],
      };
      message.contentRedactedAt = input.now.toISOString();
    }
    return Promise.resolve(candidates.length);
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
