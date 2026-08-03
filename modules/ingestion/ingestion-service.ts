import type {
  ArchiveRepository,
  IngestionResult,
} from "../archive/archive-repository.js";
import type { BlueBubblesWebhookAdapter } from "../integrations/bluebubbles/webhook-adapter.js";
import type { MessageEnvelope } from "./message-envelope.js";

export interface IngestionOutcome {
  result: IngestionResult;
  automationEnvelope: MessageEnvelope | null;
}

export class IngestionService {
  constructor(
    private readonly adapter: BlueBubblesWebhookAdapter,
    private readonly repository: ArchiveRepository,
    private readonly monitoredChatIds: ReadonlySet<string>,
  ) {}

  async ingest(
    payload: unknown,
    correlationId: string,
  ): Promise<IngestionOutcome> {
    const normalized = this.adapter.normalize(payload, correlationId);
    if (normalized.kind === "ignored") {
      return {
        result: await this.repository.recordIgnoredEvent(normalized.event),
        automationEnvelope: null,
      };
    }

    const providerChatId = normalized.envelope.chat.providerChatId;
    const persistedMonitoringState =
      await this.repository.getChatMonitoringState(providerChatId);
    const archiveEnabled =
      persistedMonitoringState ?? this.monitoredChatIds.has(providerChatId);
    const result = await this.repository.ingestMessage(
      normalized.envelope,
      archiveEnabled,
    );
    return {
      result,
      automationEnvelope:
        archiveEnabled &&
        (result.status === "archived" ||
          result.automationOutcome === "evaluation-pending")
          ? normalized.envelope
          : null,
    };
  }
}
