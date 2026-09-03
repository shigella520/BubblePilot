import type {
  ArchiveRepository,
  IngestionResult,
} from "../archive/archive-repository.js";
import type { BlueBubblesWebhookAdapter } from "../integrations/bluebubbles/webhook-adapter.js";
import type { LinkPreviewEnricher } from "../integrations/bluebubbles/link-preview-enricher.js";
import type { ImageSummaryScheduler } from "../ai/image-summary-service.js";
import type { ConversationContextService } from "../workflow/conversation-context-service.js";
import type { SummarySettingsService } from "../workflow/summary-settings-service.js";
import { emptyLinkPreview } from "./link-preview.js";
import type { MessageEnvelope } from "./message-envelope.js";

export interface IngestionOutcome {
  result: IngestionResult;
  automationEnvelope: MessageEnvelope | null;
}

function scheduleImageSummary(operation: (() => Promise<void>) | undefined) {
  if (operation === undefined) return;
  void Promise.resolve()
    .then(operation)
    .catch(() => {
      // Summary persistence is best-effort and must not delay message automation.
    });
}

export class IngestionService {
  constructor(
    private readonly adapter: BlueBubblesWebhookAdapter,
    private readonly repository: ArchiveRepository,
    private readonly monitoredChatIds: ReadonlySet<string>,
    private readonly linkPreviewEnricher?: LinkPreviewEnricher,
    private readonly imageSummary?: ImageSummaryScheduler,
    private readonly conversationSummary?: ConversationContextService,
    private readonly summarySettings?: SummarySettingsService,
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
    const imageSummary = this.imageSummary;
    if (result.messageId !== null && imageSummary !== undefined) {
      const messageId = result.messageId;
      scheduleImageSummary(() =>
        imageSummary.enqueueAttachments(messageId, normalized.envelope),
      );
    }
    if (
      result.messageId !== null &&
      this.conversationSummary !== undefined &&
      this.summarySettings !== undefined
    ) {
      const settings = await this.summarySettings.view();
      if (settings.enabled && settings.providerRouteId !== "") {
        scheduleImageSummary(() =>
          this.conversationSummary!.enqueueForMessage({
            provider: normalized.envelope.provider,
            providerChatId: normalized.envelope.chat.providerChatId,
            providerMessageId: normalized.envelope.message.providerMessageId,
            routeId: settings.providerRouteId,
            messageLimit: settings.messageLimit,
            characterLimit: settings.characterLimit,
            compressionBatchSize: settings.compressionBatchSize,
            timeZone: settings.timeZone,
            summaryPolicyVersion: settings.policyVersion,
            correlationId,
            includeFromMe: settings.includeFromMe,
          }),
        );
      }
    }
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
        if (
          result.messageId !== null &&
          saved !== null &&
          imageSummary !== undefined
        ) {
          const messageId = result.messageId;
          scheduleImageSummary(() =>
            imageSummary.enqueueLinkPreviews({
              messageId,
              providerMessageId: normalized.envelope.message.providerMessageId,
              linkPreview: saved,
            }),
          );
        }
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
