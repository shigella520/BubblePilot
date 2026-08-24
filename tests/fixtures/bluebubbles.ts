export function newMessageWebhook(
  overrides: {
    messageGuid?: string;
    chatGuid?: string;
    text?: string | null;
    isFromMe?: boolean;
    senderAddress?: string;
    chatDisplayName?: string | null;
    chatIdentifier?: string | null;
    dateCreated?: number;
  } = {},
) {
  return {
    type: "new-message",
    data: {
      guid: overrides.messageGuid ?? "fake-message-guid-001",
      text:
        overrides.text === undefined
          ? "Hello from a fictional chat"
          : overrides.text,
      dateCreated: overrides.dateCreated ?? 1_788_000_000_000,
      isFromMe: overrides.isFromMe ?? false,
      handle: {
        address: overrides.senderAddress ?? "fictional-user@example.test",
        service: "iMessage",
      },
      chats: [
        {
          guid: overrides.chatGuid ?? "iMessage;-;fictional-chat",
          style: 45,
          displayName: overrides.chatDisplayName ?? null,
          chatIdentifier:
            overrides.chatIdentifier === undefined
              ? "fictional-chat"
              : overrides.chatIdentifier,
        },
      ],
      attachments: [],
    },
  };
}

export function groupAttachmentWebhook() {
  return {
    type: "new-message",
    data: {
      guid: "fake-message-guid-attachment",
      text: "Fictional image",
      dateCreated: 1_788_000_100_000,
      isFromMe: true,
      handle: null,
      chats: [
        {
          guid: "iMessage;+;fictional-group",
          style: 43,
          displayName: "Fictional Group",
        },
      ],
      attachments: [
        {
          guid: "fake-attachment-guid",
          mimeType: "image/png",
          transferName: "fictional-image.png",
          totalBytes: 2048,
        },
      ],
    },
  };
}
