import type {
  DeliveryResult,
  ReplyGateway,
  SendReplyCommand,
} from "./reply-gateway.js";
import { BlueBubblesRestReplyGateway } from "./rest-reply-gateway.js";
import type { BlueBubblesSettingsService } from "./settings-service.js";

export class ManagedBlueBubblesReplyGateway implements ReplyGateway {
  constructor(private readonly settings: BlueBubblesSettingsService) {}

  async sendReply(command: SendReplyCommand): Promise<DeliveryResult> {
    const current = await this.settings.resolve();
    return new BlueBubblesRestReplyGateway({
      serverUrl: current.serverUrl,
      accessToken: current.accessToken,
      method: current.sendMethod,
      timeoutMs: current.requestTimeoutMs,
    }).sendReply(command);
  }
}
