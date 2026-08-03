import type {
  IgnoredInboundEvent,
  MessageEnvelope,
} from "../ingestion/message-envelope.js";

export type IngestionStatus = "archived" | "ignored" | "duplicate";

export interface IngestionResult {
  status: IngestionStatus;
  eventId: string;
  correlationId: string;
  messageId: string | null;
}

export interface ChatSummary {
  id: string;
  providerChatId: string;
  type: "direct" | "group" | "unknown";
  displayName: string | null;
  enabled: boolean;
  messageCount: number;
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
  createdAt: string;
}

export interface PageOptions {
  limit: number;
  cursor: {
    timestamp: Date;
    id: string;
  } | null;
}

export interface ArchiveRepository {
  ingestMessage(
    envelope: MessageEnvelope,
    archiveEnabled: boolean,
  ): Promise<IngestionResult>;
  recordIgnoredEvent(event: IgnoredInboundEvent): Promise<IngestionResult>;
  listChats(options: PageOptions): Promise<readonly ChatSummary[]>;
  listMessages(
    chatId: string,
    options: PageOptions,
  ): Promise<readonly ArchivedMessage[]>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
