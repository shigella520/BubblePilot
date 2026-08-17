import type {
  IgnoredInboundEvent,
  MessageAttachment,
  MessageEnvelope,
} from "../ingestion/message-envelope.js";
import type {
  LinkPreviewBundle,
  LinkPreviewDiagnostic,
} from "../ingestion/link-preview.js";
import type { MessageImageSummary } from "../ai/image-summary-types.js";

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
  attachments: readonly MessageAttachment[];
  linkPreview: LinkPreviewBundle;
  linkPreviewDiagnostics: readonly LinkPreviewDiagnostic[];
  linkPreviewFetchedAt: string | null;
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
  attachments: readonly MessageAttachment[];
  linkPreview: LinkPreviewBundle;
  imageSummaries?: readonly MessageImageSummary[];
}

export interface ContextWindowOptions {
  limit: number;
  maxCharacters: number;
  includeFromMe: boolean;
  beforeProviderMessageId: string;
}

export interface ChatParticipantIdentity {
  senderId: string;
  realName: string | null;
  nickname: string | null;
}

export interface ChatParticipantView extends ChatParticipantIdentity {
  messageCount: number;
  lastSeenAt: string;
}

export interface ChatParticipantIdentitySet {
  chatId: string;
  version: number;
  participants: readonly ChatParticipantView[];
}

export type ChatParticipantIdentityMutation =
  | { status: "ok"; value: ChatParticipantIdentitySet }
  | { status: "not-found" }
  | { status: "conflict" }
  | { status: "invalid-sender"; senderIds: readonly string[] };

export interface ArchiveRepository {
  ingestMessage(
    envelope: MessageEnvelope,
    archiveEnabled: boolean,
  ): Promise<IngestionResult>;
  recordIgnoredEvent(event: IgnoredInboundEvent): Promise<IngestionResult>;
  saveMessageLinkPreview(input: {
    providerMessageId: string;
    linkPreview: LinkPreviewBundle;
    diagnostics: readonly LinkPreviewDiagnostic[];
    fetchedAt: Date;
  }): Promise<LinkPreviewBundle | null>;
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
  getChatParticipants(
    chatId: string,
  ): Promise<ChatParticipantIdentitySet | null>;
  saveChatParticipantIdentities(input: {
    chatId: string;
    expectedVersion: number;
    identities: readonly ChatParticipantIdentity[];
  }): Promise<ChatParticipantIdentityMutation>;
  resolveParticipantIdentities(
    providerChatId: string,
    senderIds: readonly string[],
  ): Promise<readonly ChatParticipantIdentity[]>;
  listMessages(
    chatId: string,
    options: PageOptions,
  ): Promise<readonly ArchivedMessage[]>;
  findMessage(messageId: string): Promise<ArchivedMessage | null>;
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
