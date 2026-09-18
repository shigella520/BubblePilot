export interface SendReplyCommand {
  providerChatId: string;
  text: string;
  replyToProviderMessageId: string | null;
  idempotencyKey: string;
  providerTempGuid: string;
  correlationId: string;
}

export type DeliveryResult =
  | {
      status: "confirmed";
      providerMessageId: string | null;
    }
  | {
      status: "failed";
      code: string;
      summary: string;
      retryable: boolean;
    }
  | {
      status: "unknown";
      code: string;
      summary: string;
    };

export interface SendAttachmentCommand {
  providerChatId: string;
  providerTempGuid: string;
  idempotencyKey: string;
  correlationId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export interface ReplyGateway {
  sendAttachment?(command: SendAttachmentCommand): Promise<DeliveryResult>;
  sendReply(command: SendReplyCommand): Promise<DeliveryResult>;
}
