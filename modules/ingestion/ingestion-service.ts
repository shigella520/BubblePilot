import type {
  ArchiveRepository,
  IngestionResult,
} from "../archive/archive-repository.js";
import type { BlueBubblesWebhookAdapter } from "../integrations/bluebubbles/webhook-adapter.js";
import type { LinkPreviewEnricher } from "../integrations/bluebubbles/link-preview-enricher.js";
import { emptyLinkPreview } from "./link-preview.js";
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
    private readonly linkPreviewEnricher?: LinkPreviewEnricher,
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
    let automationEnvelope = normalized.envelope;
    if (
      this.linkPreviewEnricher !== undefined &&
      normalized.envelope.message.linkPreview.status === "pending" &&
      (result.status === "archived" ||
        result.automationOutcome === "evaluation-pending")
    ) {
      try {
        const enrichment = await this.linkPreviewEnricher.enrich(
          normalized.envelope,
        );
        const saved = await this.repository.saveMessageLinkPreview({
          providerMessageId: normalized.envelope.message.providerMessageId,
          linkPreview: enrichment.linkPreview,
          diagnostics: enrichment.diagnostics,
          fetchedAt: new Date(),
        });
        automationEnvelope = {
          ...normalized.envelope,
          message: {
            ...normalized.envelope.message,
            linkPreview: saved ?? enrichment.linkPreview,
          },
        };
      } catch {
        const failed = emptyLinkPreview(
          "failed",
          "LINK_PREVIEW_ENRICHMENT_FAILED",
        );
        await this.repository.saveMessageLinkPreview({
          providerMessageId: normalized.envelope.message.providerMessageId,
          linkPreview: failed,
          diagnostics: [],
          fetchedAt: new Date(),
        });
        automationEnvelope = {
          ...normalized.envelope,
          message: { ...normalized.envelope.message, linkPreview: failed },
        };
      }
    }
    return {
      result,
      automationEnvelope:
        archiveEnabled &&
        (result.status === "archived" ||
          result.automationOutcome === "evaluation-pending")
          ? automationEnvelope
          : null,
    };
  }
}
