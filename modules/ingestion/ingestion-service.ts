import type {
  ArchiveRepository,
  IngestionResult,
} from "../archive/archive-repository.js";
import type { BlueBubblesWebhookAdapter } from "../integrations/bluebubbles/webhook-adapter.js";

export class IngestionService {
  constructor(
    private readonly adapter: BlueBubblesWebhookAdapter,
    private readonly repository: ArchiveRepository,
    private readonly monitoredChatIds: ReadonlySet<string>,
  ) {}

  async ingest(
    payload: unknown,
    correlationId: string,
  ): Promise<IngestionResult> {
    const normalized = this.adapter.normalize(payload, correlationId);
    if (normalized.kind === "ignored") {
      return this.repository.recordIgnoredEvent(normalized.event);
    }

    const archiveEnabled = this.monitoredChatIds.has(
      normalized.envelope.chat.providerChatId,
    );
    return this.repository.ingestMessage(normalized.envelope, archiveEnabled);
  }
}
