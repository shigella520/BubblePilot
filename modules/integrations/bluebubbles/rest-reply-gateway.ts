import { z } from "zod";

import type {
  DeliveryResult,
  SendAttachmentCommand,
  ReplyGateway,
  SendReplyCommand,
} from "./reply-gateway.js";
import { normalizeIMessageText } from "./imessage-text.js";
import {
  DeliveryDiagnostics,
  type DeliveryDiagnosticSink,
} from "./delivery-diagnostics.js";

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
  onDiagnostic?: DeliveryDiagnosticSink | undefined;
}

export class BlueBubblesRestReplyGateway implements ReplyGateway {
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: BlueBubblesRestReplyGatewayOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async sendAttachment(
    command: SendAttachmentCommand,
  ): Promise<DeliveryResult> {
    const endpoint = new URL(
      "/api/v1/message/attachment",
      `${this.options.serverUrl}/`,
    );
    endpoint.searchParams.set("password", this.options.accessToken);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const diagnostic = new DeliveryDiagnostics(
      "attachment",
      "apple-script",
      command,
      this.options.timeoutMs,
      controller.signal,
      this.options.onDiagnostic,
    );
    try {
      const form = new FormData();
      form.set("chatGuid", command.providerChatId);
      form.set("method", "apple-script");
      form.set("tempGuid", command.providerTempGuid);
      form.set("name", command.filename);
      form.set(
        "attachment",
        new Blob([new Uint8Array(command.bytes)], { type: command.mimeType }),
        command.filename,
      );
      diagnostic.stage = "request";
      const response = await this.fetchImplementation(endpoint, {
        method: "POST",
        headers: { "x-bubblepilot-correlation-id": command.correlationId },
        body: form,
        signal: controller.signal,
      });
      diagnostic.httpStatus = response.status;
      diagnostic.stage = "http-status";
      if (!response.ok) {
        diagnostic.report(`BLUEBUBBLES_HTTP_${response.status}`);
        return {
          status: response.status >= 500 ? "unknown" : "failed",
          code: `BLUEBUBBLES_HTTP_${response.status}`,
          summary: `Attachment request returned HTTP ${response.status}.`,
          retryable: response.status === 429,
        };
      }
      const parsed = z
        .object({
          data: z.object({
            guid: z.string().min(1),
            error: z.number().optional(),
          }),
        })
        .safeParse(await diagnostic.readJson(response));
      if (!parsed.success) {
        diagnostic.report("BLUEBUBBLES_ATTACHMENT_RESULT_UNKNOWN");
        return {
          status: "unknown",
          code: "BLUEBUBBLES_ATTACHMENT_RESULT_UNKNOWN",
          summary: "Attachment receipt could not be confirmed.",
        };
      }
      if (parsed.data.data.error && parsed.data.data.error !== 0) {
        diagnostic.report("BLUEBUBBLES_ATTACHMENT_REJECTED");
        return {
          status: "failed",
          code: "BLUEBUBBLES_ATTACHMENT_REJECTED",
          summary: "The attachment was rejected by the gateway.",
          retryable: false,
        };
      }
      return { status: "confirmed", providerMessageId: parsed.data.data.guid };
    } catch (error) {
      diagnostic.report("BLUEBUBBLES_ATTACHMENT_RESULT_UNKNOWN", error);
      return {
        status: "unknown",
        code: "BLUEBUBBLES_ATTACHMENT_RESULT_UNKNOWN",
        summary:
          "Attachment delivery could not be confirmed; do not resend without checking.",
      };
    } finally {
      clearTimeout(timer);
    }
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
    const diagnostic = new DeliveryDiagnostics(
      "text",
      this.options.method,
      command,
      this.options.timeoutMs,
      controller.signal,
      this.options.onDiagnostic,
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

      diagnostic.stage = "request";
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

      diagnostic.httpStatus = response.status;
      diagnostic.stage = "http-status";
      if (response.ok) {
        const parsed = successResponseSchema.safeParse(
          await diagnostic.readJson(response),
        );
        if (!parsed.success || !parsed.data.data?.guid)
          diagnostic.report("BLUEBUBBLES_REPLY_RECEIPT_MISSING_GUID");
        return {
          status: "confirmed",
          providerMessageId: parsed.success
            ? (parsed.data.data?.guid ?? null)
            : null,
        };
      }

      const retryable = response.status === 429 || response.status >= 500;
      diagnostic.report(
        response.status === 429
          ? "BLUEBUBBLES_RATE_LIMITED"
          : `BLUEBUBBLES_HTTP_${response.status}`,
      );
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
      diagnostic.report(
        timedOut
          ? "BLUEBUBBLES_REPLY_TIMEOUT"
          : "BLUEBUBBLES_REPLY_RESULT_UNKNOWN",
        error,
      );
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
