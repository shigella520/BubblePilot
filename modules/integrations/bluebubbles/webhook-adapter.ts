import { z } from "zod";

import { hashJson, sha256 } from "../../../app/canonical-json.js";
import { InvalidWebhookError } from "../../../app/errors.js";
import {
  MESSAGE_ENVELOPE_SCHEMA_VERSION,
  type MessageAttachment,
  type MessageEnvelope,
  type NormalizedInboundEvent,
} from "../../ingestion/message-envelope.js";
import { emptyLinkPreview } from "../../ingestion/link-preview.js";

const ADAPTER_VERSION = "1";

const webhookEventSchema = z
  .object({
    type: z.string().min(1),
    data: z.unknown(),
  })
  .passthrough();

const handleSchema = z
  .object({
    address: z.string().min(1),
  })
  .passthrough();

const chatSchema = z
  .object({
    guid: z.string().min(1),
    style: z.number().int().optional(),
    displayName: z.string().nullable().optional(),
    chatIdentifier: z.string().nullable().optional(),
  })
  .passthrough();

const attachmentSchema = z
  .object({
    guid: z.string().min(1),
    mimeType: z.string().nullable().optional(),
    transferName: z.string().nullable().optional(),
    totalBytes: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();

const newMessageSchema = z
  .object({
    guid: z.string().min(1),
    text: z.string().nullable().optional(),
    dateCreated: z.number().int().nonnegative(),
    isFromMe: z.boolean(),
    handle: handleSchema.nullable().optional(),
    chats: z.array(chatSchema).min(1),
    attachments: z.array(attachmentSchema).default([]),
    hasPayloadData: z.boolean().optional(),
  })
  .passthrough();

function chatType(style: number | undefined): MessageEnvelope["chat"]["type"] {
  if (style === 43) {
    return "group";
  }
  if (style === 45) {
    return "direct";
  }
  return "unknown";
}

function chatDisplayName(
  chat: {
    guid: string;
    displayName?: string | null | undefined;
    chatIdentifier?: string | null | undefined;
  },
  type: MessageEnvelope["chat"]["type"],
): string | null {
  const explicit = chat.displayName?.trim();
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }
  if (type !== "direct") {
    return null;
  }

  // iMessage cannot name one-on-one chats, so BlueBubbles leaves displayName
  // empty for direct conversations. The peer's phone number or email address
  // is carried in chatIdentifier, and the chat guid's trailing segment is the
  // same handle for `iMessage;-;<handle>`.
  const identifier = chat.chatIdentifier?.trim();
  if (identifier !== undefined && identifier !== "") {
    return identifier;
  }
  const guidTail = chat.guid.split(";").at(-1)?.trim();
  return guidTail === undefined || guidTail === "" ? null : guidTail;
}

function contentType(
  text: string | null,
  attachments: readonly MessageAttachment[],
) {
  if (text !== null && attachments.length > 0) {
    return "mixed" as const;
  }
  if (text !== null) {
    return "text" as const;
  }
  if (attachments.length > 0) {
    return "attachment" as const;
  }
  return "unknown" as const;
}

export class BlueBubblesWebhookAdapter {
  normalize(payload: unknown, correlationId: string): NormalizedInboundEvent {
    const eventResult = webhookEventSchema.safeParse(payload);
    if (!eventResult.success) {
      throw new InvalidWebhookError(
        "The BlueBubbles webhook envelope is invalid.",
        {
          cause: eventResult.error,
        },
      );
    }

    const event = eventResult.data;
    const payloadHash = hashJson(payload);
    if (event.type !== "new-message") {
      return {
        kind: "ignored",
        event: {
          provider: "bluebubbles",
          eventId: `${event.type}:${payloadHash}`,
          correlationId,
          eventType: event.type,
          payloadHash,
          reason: "unsupported-event",
        },
      };
    }

    const messageResult = newMessageSchema.safeParse(event.data);
    if (!messageResult.success) {
      throw new InvalidWebhookError(
        "The BlueBubbles new-message payload is invalid.",
        {
          cause: messageResult.error,
        },
      );
    }

    const data = messageResult.data;
    const chat = data.chats[0];
    if (chat === undefined) {
      throw new InvalidWebhookError(
        "The BlueBubbles message does not reference a chat.",
      );
    }

    const attachments = data.attachments.map(
      (attachment): MessageAttachment => ({
        providerAttachmentId: attachment.guid,
        mimeType: attachment.mimeType ?? null,
        fileName: attachment.transferName ?? null,
        sizeBytes: attachment.totalBytes ?? null,
      }),
    );
    const text = data.text ?? null;
    const linkPreviewRequested =
      data.hasPayloadData === true || /https?:\/\/[^\s<]+/iu.test(text ?? "");
    const sentAt = new Date(data.dateCreated);
    if (Number.isNaN(sentAt.getTime())) {
      throw new InvalidWebhookError(
        "The BlueBubbles message timestamp is invalid.",
      );
    }

    const chatTypeValue = chatType(chat.style);

    return {
      kind: "message",
      envelope: {
        schemaVersion: MESSAGE_ENVELOPE_SCHEMA_VERSION,
        eventId: `${event.type}:${data.guid}`,
        correlationId,
        provider: "bluebubbles",
        chat: {
          providerChatId: chat.guid,
          type: chatTypeValue,
          displayName: chatDisplayName(chat, chatTypeValue),
        },
        message: {
          providerMessageId: data.guid,
          senderId: data.isFromMe ? "self" : (data.handle?.address ?? null),
          sentAt: sentAt.toISOString(),
          text,
          contentType: contentType(text, attachments),
          isFromMe: data.isFromMe,
          attachments,
          linkPreview: emptyLinkPreview(
            linkPreviewRequested ? "pending" : "not-requested",
          ),
          contentHash: sha256(JSON.stringify({ text, attachments })),
        },
        metadata: {
          isReplay: false,
          payloadHash,
          eventType: event.type,
          adapterVersion: ADAPTER_VERSION,
        },
      },
    };
  }
}
