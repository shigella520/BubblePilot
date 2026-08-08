import type { LinkPreviewBundle } from "./link-preview.js";

export const MESSAGE_ENVELOPE_SCHEMA_VERSION = "2" as const;

export interface MessageAttachment {
  providerAttachmentId: string;
  mimeType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
}

export interface MessageEnvelope {
  schemaVersion: typeof MESSAGE_ENVELOPE_SCHEMA_VERSION;
  eventId: string;
  correlationId: string;
  provider: "bluebubbles";
  chat: {
    providerChatId: string;
    type: "direct" | "group" | "unknown";
    displayName: string | null;
  };
  message: {
    providerMessageId: string;
    senderId: string | null;
    sentAt: string;
    text: string | null;
    contentType: "text" | "attachment" | "mixed" | "unknown";
    isFromMe: boolean;
    attachments: readonly MessageAttachment[];
    linkPreview: LinkPreviewBundle;
    contentHash: string;
  };
  metadata: {
    isReplay: boolean;
    payloadHash: string;
    eventType: string;
    adapterVersion: string;
  };
}

export interface IgnoredInboundEvent {
  provider: "bluebubbles";
  eventId: string;
  correlationId: string;
  eventType: string;
  payloadHash: string;
  reason: "unsupported-event";
}

export type NormalizedInboundEvent =
  | { kind: "message"; envelope: MessageEnvelope }
  | { kind: "ignored"; event: IgnoredInboundEvent };
