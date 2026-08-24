import { describe, expect, it } from "vitest";

import { InvalidWebhookError } from "../app/errors.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import {
  groupAttachmentWebhook,
  newMessageWebhook,
} from "./fixtures/bluebubbles.js";

const correlationId = "9ef5bb46-c9bc-4be7-9084-50fd1136f32d";

describe("BlueBubblesWebhookAdapter", () => {
  const adapter = new BlueBubblesWebhookAdapter();

  it("normalizes a direct text message", () => {
    const result = adapter.normalize(newMessageWebhook(), correlationId);

    expect(result.kind).toBe("message");
    if (result.kind !== "message") {
      return;
    }
    expect(result.envelope).toMatchObject({
      schemaVersion: "3",
      eventId: "new-message:fake-message-guid-001",
      correlationId,
      provider: "bluebubbles",
      chat: {
        providerChatId: "iMessage;-;fictional-chat",
        type: "direct",
        displayName: "fictional-chat",
      },
      message: {
        senderId: "fictional-user@example.test",
        contentType: "text",
        isFromMe: false,
        attachments: [],
      },
      metadata: {
        eventType: "new-message",
        adapterVersion: "1",
      },
    });
    expect(result.envelope.metadata.payloadHash).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
  });

  it("normalizes an outgoing group message with attachment metadata", () => {
    const result = adapter.normalize(groupAttachmentWebhook(), correlationId);

    expect(result.kind).toBe("message");
    if (result.kind !== "message") {
      return;
    }
    expect(result.envelope.chat.type).toBe("group");
    expect(result.envelope.message).toMatchObject({
      senderId: "self",
      contentType: "mixed",
      isFromMe: true,
      attachments: [
        {
          providerAttachmentId: "fake-attachment-guid",
          mimeType: "image/png",
          fileName: "fictional-image.png",
          sizeBytes: 2048,
        },
      ],
    });
  });

  it("falls back a direct chat name to the peer handle when displayName is empty", () => {
    const result = adapter.normalize(
      newMessageWebhook({
        chatDisplayName: null,
        chatIdentifier: "+8612345678",
        senderAddress: "+8612345678",
      }),
      correlationId,
    );

    expect(result.kind).toBe("message");
    if (result.kind !== "message") {
      return;
    }
    expect(result.envelope.chat).toMatchObject({
      type: "direct",
      displayName: "+8612345678",
    });
  });

  it("derives a direct chat name from the chat guid when chatIdentifier is empty", () => {
    const result = adapter.normalize(
      newMessageWebhook({
        chatDisplayName: null,
        chatGuid: "iMessage;-;person@example.test",
        chatIdentifier: null,
      }),
      correlationId,
    );

    expect(result.kind).toBe("message");
    if (result.kind !== "message") {
      return;
    }
    expect(result.envelope.chat.displayName).toBe("person@example.test");
  });

  it("keeps group chats unnamed when displayName is empty", () => {
    const payload = newMessageWebhook({ chatDisplayName: null });
    payload.data.chats[0] = {
      guid: "iMessage;+;fictional-group",
      style: 43,
      displayName: null,
      chatIdentifier: "fictional-group-identifier",
    };

    const result = adapter.normalize(payload, correlationId);

    expect(result.kind).toBe("message");
    if (result.kind !== "message") {
      return;
    }
    expect(result.envelope.chat.displayName).toBeNull();
  });

  it("turns unsupported event types into observable ignored events", () => {
    const result = adapter.normalize(
      { type: "typing-indicator", data: { typing: true } },
      correlationId,
    );

    expect(result).toMatchObject({
      kind: "ignored",
      event: {
        eventType: "typing-indicator",
        reason: "unsupported-event",
      },
    });
  });

  it("rejects malformed new-message payloads", () => {
    expect(() =>
      adapter.normalize({ type: "new-message", data: {} }, correlationId),
    ).toThrow(InvalidWebhookError);
  });
});
