import type {
  DeliveryResult,
  SendAttachmentCommand,
  ReplyGateway,
  SendReplyCommand,
} from "./reply-gateway.js";
import { BlueBubblesRestReplyGateway } from "./rest-reply-gateway.js";
import type { BlueBubblesSettingsService } from "./settings-service.js";
import type { DeliveryDiagnosticSink } from "./delivery-diagnostics.js";

export class ManagedBlueBubblesReplyGateway implements ReplyGateway {
  constructor(
    private readonly settings: BlueBubblesSettingsService,
    private readonly onDiagnostic?: DeliveryDiagnosticSink,
  ) {}

  async sendAttachment(
    command: SendAttachmentCommand,
  ): Promise<DeliveryResult> {
    const current = await this.settings.resolve();
    return new BlueBubblesRestReplyGateway({
      serverUrl: current.serverUrl,
      accessToken: current.accessToken,
      method: "apple-script",
      timeoutMs: current.requestTimeoutMs,
      onDiagnostic: this.onDiagnostic,
    }).sendAttachment(command);
  }
  async sendReply(command: SendReplyCommand): Promise<DeliveryResult> {
    const current = await this.settings.resolve();
    return new BlueBubblesRestReplyGateway({
      serverUrl: current.serverUrl,
      accessToken: current.accessToken,
      method: current.sendMethod,
      timeoutMs: current.requestTimeoutMs,
      onDiagnostic: this.onDiagnostic,
    }).sendReply(command);
  }
}
