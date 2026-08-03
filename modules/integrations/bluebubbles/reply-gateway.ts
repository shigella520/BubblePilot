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

export interface ReplyGateway {
  sendReply(command: SendReplyCommand): Promise<DeliveryResult>;
}
