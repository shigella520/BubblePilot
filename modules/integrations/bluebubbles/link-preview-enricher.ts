import type {
  LinkPreviewBundle,
  LinkPreviewDiagnostic,
  LinkPreviewItem,
} from "../../ingestion/link-preview.js";
import { emptyLinkPreview } from "../../ingestion/link-preview.js";
import type { MessageEnvelope } from "../../ingestion/message-envelope.js";
import { parseBlueBubblesLinkPreviews } from "./link-preview-parser.js";
import { OpenGraphClient, OpenGraphFetchError } from "./open-graph-client.js";
import type { BlueBubblesSettingsService } from "./settings-service.js";

const blueBubblesDelays = [0, 500, 1_500] as const;
const openGraphDelays = [0, 300] as const;

export interface LinkPreviewEnrichmentResult {
  linkPreview: LinkPreviewBundle;
  diagnostics: readonly LinkPreviewDiagnostic[];
}

export interface LinkPreviewEnricher {
  enrich(envelope: MessageEnvelope): Promise<LinkPreviewEnrichmentResult>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function urls(text: string | null): readonly string[] {
  if (text === null) return [];
  const found = text.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
  return [
    ...new Set(
      found.flatMap((value) => {
        const candidate = value.replace(/[),.;!?，。；！？）》】]+$/gu, "");
        try {
          const parsed = new URL(candidate);
          return [parsed.toString()];
        } catch {
          return [];
        }
      }),
    ),
  ];
}

function usable(items: readonly LinkPreviewItem[]): boolean {
  return items.some(
    (item) =>
      item.title !== null ||
      item.summary !== null ||
      item.siteName !== null ||
      item.imageUrl !== null,
  );
}

function blueBubblesError(
  error: unknown,
  aborted: boolean,
): { code: string; retryable: boolean } {
  if (aborted)
    return { code: "LINK_PREVIEW_BLUEBUBBLES_TIMEOUT", retryable: true };
  return {
    code: "LINK_PREVIEW_BLUEBUBBLES_CONNECTION_FAILED",
    retryable: true,
  };
}

export class ManagedLinkPreviewEnricher implements LinkPreviewEnricher {
  private readonly active = new Map<
    string,
    Promise<LinkPreviewEnrichmentResult>
  >();

  constructor(
    private readonly settings: BlueBubblesSettingsService,
    private readonly openGraph = new OpenGraphClient(),
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  enrich(envelope: MessageEnvelope): Promise<LinkPreviewEnrichmentResult> {
    if (envelope.message.linkPreview.status !== "pending")
      return Promise.resolve({
        linkPreview: envelope.message.linkPreview,
        diagnostics: [],
      });
    const key = envelope.message.providerMessageId;
    const running = this.active.get(key);
    if (running !== undefined) return running;
    const promise = this.run(envelope).finally(() => this.active.delete(key));
    this.active.set(key, promise);
    return promise;
  }

  private async run(
    envelope: MessageEnvelope,
  ): Promise<LinkPreviewEnrichmentResult> {
    const settings = await this.settings.resolve();
    if (!settings.linkPreviewEnabled)
      return { linkPreview: emptyLinkPreview(), diagnostics: [] };

    const diagnostics: LinkPreviewDiagnostic[] = [];
    let blueBubblesItems: readonly LinkPreviewItem[] = [];
    let usableBlueBubblesItems: readonly LinkPreviewItem[] = [];
    let fallbackUrl = urls(envelope.message.text)[0] ?? null;
    let finalCode: string | null = null;

    for (let index = 0; index < blueBubblesDelays.length; index += 1) {
      await delay(blueBubblesDelays[index] ?? 0);
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        settings.requestTimeoutMs,
      );
      try {
        const endpoint = new URL(
          `/api/v1/message/${encodeURIComponent(envelope.message.providerMessageId)}`,
          `${settings.serverUrl}/`,
        );
        endpoint.searchParams.set("with", "payloadData");
        endpoint.searchParams.set("password", settings.accessToken);
        const response = await this.fetchImplementation(endpoint, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const durationMs = Date.now() - startedAt;
        if (response.ok) {
          const body = (await response.json()) as Record<string, unknown>;
          const data =
            typeof body.data === "object" && body.data !== null
              ? (body.data as Record<string, unknown>)
              : body;
          blueBubblesItems = parseBlueBubblesLinkPreviews(data.payloadData);
          fallbackUrl = blueBubblesItems[0]?.url ?? fallbackUrl;
          diagnostics.push({
            source: "bluebubbles",
            attempt: index + 1,
            status: usable(blueBubblesItems) ? "succeeded" : "empty",
            durationMs,
            httpStatus: response.status,
            code: null,
          });
          if (usable(blueBubblesItems)) {
            usableBlueBubblesItems = blueBubblesItems;
            if (
              !settings.openGraphFallbackEnabled ||
              blueBubblesItems.every(
                (item) => !item.imageAvailable || item.imageUrl !== null,
              )
            )
              return {
                linkPreview: {
                  status: "available",
                  errorCode: null,
                  items: blueBubblesItems.slice(0, 4),
                },
                diagnostics,
              };
            break;
          }
          finalCode = "LINK_PREVIEW_BLUEBUBBLES_EMPTY";
          continue;
        }
        const retryable =
          response.status === 404 ||
          response.status === 429 ||
          response.status >= 500;
        finalCode = `LINK_PREVIEW_BLUEBUBBLES_HTTP_${response.status}`;
        diagnostics.push({
          source: "bluebubbles",
          attempt: index + 1,
          status: "failed",
          durationMs,
          httpStatus: response.status,
          code: finalCode,
        });
        if (!retryable) break;
      } catch (error) {
        const failure = blueBubblesError(error, controller.signal.aborted);
        finalCode = failure.code;
        diagnostics.push({
          source: "bluebubbles",
          attempt: index + 1,
          status: "failed",
          durationMs: Date.now() - startedAt,
          httpStatus: null,
          code: failure.code,
        });
        if (!failure.retryable) break;
      } finally {
        clearTimeout(timeout);
      }
    }

    if (settings.openGraphFallbackEnabled && fallbackUrl !== null) {
      for (let index = 0; index < openGraphDelays.length; index += 1) {
        await delay(openGraphDelays[index] ?? 0);
        const startedAt = Date.now();
        try {
          const item = await this.openGraph.fetch(
            fallbackUrl,
            settings.openGraphTimeoutMs,
          );
          diagnostics.push({
            source: "open-graph",
            attempt: index + 1,
            status: item === null ? "empty" : "succeeded",
            durationMs: Date.now() - startedAt,
            httpStatus: item === null ? 200 : 200,
            code: null,
          });
          if (item !== null)
            return {
              linkPreview: {
                status: "available",
                errorCode: null,
                items:
                  usableBlueBubblesItems.length === 0
                    ? [item]
                    : usableBlueBubblesItems
                        .slice(0, 4)
                        .map((existing, itemIndex) =>
                          itemIndex === 0 && item.imageUrl !== null
                            ? {
                                ...existing,
                                imageAvailable: true,
                                imageUrl: item.imageUrl,
                                imageSource: item.imageSource,
                              }
                            : existing,
                        ),
              },
              diagnostics,
            };
          finalCode = "LINK_PREVIEW_OG_EMPTY";
          break;
        } catch (error) {
          const failure =
            error instanceof OpenGraphFetchError
              ? error
              : new OpenGraphFetchError(
                  "LINK_PREVIEW_OG_CONNECTION_FAILED",
                  "The Open Graph request failed.",
                );
          finalCode = failure.code;
          diagnostics.push({
            source: "open-graph",
            attempt: index + 1,
            status: "failed",
            durationMs: Date.now() - startedAt,
            httpStatus: failure.httpStatus,
            code: failure.code,
          });
          if (
            ![
              "LINK_PREVIEW_OG_TIMEOUT",
              "LINK_PREVIEW_OG_CONNECTION_FAILED",
            ].includes(failure.code) &&
            !/^LINK_PREVIEW_OG_HTTP_(429|5\d\d)$/u.test(failure.code)
          )
            break;
        }
      }
    }

    const hadOperationalFailure = diagnostics.some(
      (item) => item.status === "failed",
    );
    if (usableBlueBubblesItems.length > 0)
      return {
        linkPreview: {
          status: "available",
          errorCode: null,
          items: usableBlueBubblesItems.slice(0, 4),
        },
        diagnostics,
      };
    return {
      linkPreview: emptyLinkPreview(
        hadOperationalFailure ? "failed" : "unavailable",
        finalCode,
      ),
      diagnostics,
    };
  }
}
