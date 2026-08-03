import type {
  IgnoredInboundEvent,
  MessageEnvelope,
} from "../ingestion/message-envelope.js";

export type IngestionStatus = "archived" | "ignored" | "duplicate";

export type AutomationOutcome =
  | "unsupported-event"
  | "chat-not-monitored"
  | "evaluation-pending"
  | "not-evaluated"
  | "no-active-triggers"
  | "no-trigger-match"
  | "matched";

export interface IngestionResult {
  status: IngestionStatus;
  eventId: string;
  correlationId: string;
  messageId: string | null;
  automationOutcome: AutomationOutcome;
}

export interface InboundEventSummary {
  id: string;
  provider: string;
  eventId: string;
  correlationId: string;
  eventType: string;
  ingestionStatus: "accepted" | "ignored" | "completed" | "failed";
  automationOutcome: AutomationOutcome;
  receivedAt: string;
}

export interface ChatSummary {
  id: string;
  providerChatId: string;
  type: "direct" | "group" | "unknown";
  displayName: string | null;
  enabled: boolean;
  messageCount: number;
  version: number;
  updatedAt: string;
}

export interface ArchivedMessage {
  id: string;
  providerMessageId: string;
  senderId: string | null;
  sentAt: string;
  body: string | null;
  contentType: "text" | "attachment" | "mixed" | "unknown";
  isFromMe: boolean;
  attachments: readonly unknown[];
  contentRedactedAt: string | null;
  createdAt: string;
}

export interface MessageRetentionBatchInput {
  before: Date;
  now: Date;
  limit: number;
  retentionDays: number;
  correlationId: string;
}

export interface MessageSearchResult extends ArchivedMessage {
  chatId: string;
  providerChatId: string;
  chatDisplayName: string | null;
}

export interface MessageSearchOptions extends PageOptions {
  chatId: string | null;
  keyword: string | null;
  senderId: string | null;
  sentFrom: Date | null;
  sentTo: Date | null;
}

export type ChatMonitoringMutation =
  | { status: "ok"; value: ChatSummary }
  | { status: "not-found" }
  | { status: "conflict" };

export interface PageOptions {
  limit: number;
  cursor: {
    timestamp: Date;
    id: string;
  } | null;
}

export interface ContextMessage {
  providerMessageId: string;
  senderId: string | null;
  sentAt: string;
  body: string;
  isFromMe: boolean;
}

export interface ContextWindowOptions {
  limit: number;
  maxCharacters: number;
  includeFromMe: boolean;
  excludeProviderMessageId: string | null;
}

export interface ArchiveRepository {
  ingestMessage(
    envelope: MessageEnvelope,
    archiveEnabled: boolean,
  ): Promise<IngestionResult>;
  recordIgnoredEvent(event: IgnoredInboundEvent): Promise<IngestionResult>;
  recordAutomationOutcome(
    provider: string,
    eventId: string,
    outcome: AutomationOutcome,
  ): Promise<AutomationOutcome>;
  listInboundEvents(
    options: PageOptions,
  ): Promise<readonly InboundEventSummary[]>;
  listChats(options: PageOptions): Promise<readonly ChatSummary[]>;
  listChatMonitoring(options: PageOptions): Promise<readonly ChatSummary[]>;
  getChatMonitoringState(providerChatId: string): Promise<boolean | null>;
  setChatMonitoring(input: {
    chatId: string;
    enabled: boolean;
    expectedVersion: number;
  }): Promise<ChatMonitoringMutation>;
  listMessages(
    chatId: string,
    options: PageOptions,
  ): Promise<readonly ArchivedMessage[]>;
  searchMessages(
    options: MessageSearchOptions,
  ): Promise<readonly MessageSearchResult[]>;
  loadRecentMessages(
    providerChatId: string,
    options: ContextWindowOptions,
  ): Promise<readonly ContextMessage[]>;
  redactExpiredMessageContent(
    input: MessageRetentionBatchInput,
  ): Promise<number>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
