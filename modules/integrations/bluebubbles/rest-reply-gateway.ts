import { z } from "zod";

import type {
  DeliveryResult,
  ReplyGateway,
  SendReplyCommand,
} from "./reply-gateway.js";
import { normalizeIMessageText } from "./imessage-text.js";

const successResponseSchema = z
  .object({
    data: z
      .object({
        guid: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface BlueBubblesRestReplyGatewayOptions {
  serverUrl: string;
  accessToken: string;
  method: "private-api" | "apple-script";
  timeoutMs: number;
  fetchImplementation?: typeof fetch;
}

export class BlueBubblesRestReplyGateway implements ReplyGateway {
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: BlueBubblesRestReplyGatewayOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async sendReply(command: SendReplyCommand): Promise<DeliveryResult> {
    const endpoint = new URL(
      "/api/v1/message/text",
      `${this.options.serverUrl}/`,
    );
    endpoint.searchParams.set("password", this.options.accessToken);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs,
    );

    try {
      const payload: Record<string, unknown> = {
        chatGuid: command.providerChatId,
        message: normalizeIMessageText(command.text),
        method: this.options.method,
        tempGuid: command.providerTempGuid,
      };
      if (command.replyToProviderMessageId !== null) {
        payload.selectedMessageGuid = command.replyToProviderMessageId;
        payload.partIndex = 0;
      }

      const response = await this.fetchImplementation(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bubblepilot-correlation-id": command.correlationId,
          "x-bubblepilot-idempotency-key": command.idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok) {
        const parsed = successResponseSchema.safeParse(await response.json());
        return {
          status: "confirmed",
          providerMessageId: parsed.success
            ? (parsed.data.data?.guid ?? null)
            : null,
        };
      }

      const retryable = response.status === 429 || response.status >= 500;
      return {
        status: "failed",
        code:
          response.status === 429
            ? "BLUEBUBBLES_RATE_LIMITED"
            : `BLUEBUBBLES_HTTP_${response.status}`,
        summary: `BlueBubbles rejected the reply with HTTP ${response.status}.`,
        retryable,
      };
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (error.name === "AbortError" || controller.signal.aborted);
      return {
        status: "unknown",
        code: timedOut
          ? "BLUEBUBBLES_REPLY_TIMEOUT"
          : "BLUEBUBBLES_REPLY_RESULT_UNKNOWN",
        summary: timedOut
          ? "The BlueBubbles reply timed out and its final state is unknown."
          : "The BlueBubbles reply result could not be confirmed.",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
