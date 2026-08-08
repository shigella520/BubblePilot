import { describe, expect, it, vi } from "vitest";

import type { MessageEnvelope } from "../modules/ingestion/message-envelope.js";
import { ManagedLinkPreviewEnricher } from "../modules/integrations/bluebubbles/link-preview-enricher.js";
import type { OpenGraphClient } from "../modules/integrations/bluebubbles/open-graph-client.js";
import type { BlueBubblesSettingsRepository } from "../modules/integrations/bluebubbles/settings-repository.js";
import { SettingsCipher } from "../modules/integrations/bluebubbles/settings-cipher.js";
import { BlueBubblesSettingsService } from "../modules/integrations/bluebubbles/settings-service.js";

const envelope: MessageEnvelope = {
  schemaVersion: "2",
  eventId: "fictional-event",
  correlationId: "fictional-correlation",
  provider: "bluebubbles",
  chat: {
    providerChatId: "iMessage;-;fictional-chat",
    type: "direct",
    displayName: null,
  },
  message: {
    providerMessageId: "fictional-message",
    senderId: "fictional-user@example.test",
    sentAt: "2026-08-08T00:00:00.000Z",
    text: "See https://public.example.test/article",
    contentType: "text",
    isFromMe: false,
    attachments: [],
    linkPreview: { status: "pending", errorCode: null, items: [] },
    contentHash: `sha256:${"0".repeat(64)}`,
  },
  metadata: {
    isReplay: false,
    payloadHash: `sha256:${"1".repeat(64)}`,
    eventType: "new-message",
    adapterVersion: "bluebubbles-v1",
  },
};

function settings(input: {
  linkPreviewEnabled?: boolean;
  openGraphFallbackEnabled?: boolean;
}) {
  const repository: BlueBubblesSettingsRepository = {
    find: () => Promise.resolve(null),
    save: () => Promise.resolve({ status: "conflict" }),
    isReady: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
  return new BlueBubblesSettingsService(
    repository,
    new SettingsCipher("fictional-settings-key-32-characters"),
    {
      serverUrl: "https://bluebubbles.example.test",
      accessToken: "fictional-token",
      webhookSecret: "s".repeat(32),
      sendMethod: "private-api",
      requestTimeoutMs: 1_000,
      linkPreviewEnabled: input.linkPreviewEnabled ?? true,
      openGraphFallbackEnabled: input.openGraphFallbackEnabled ?? true,
      openGraphTimeoutMs: 1_000,
    },
  );
}

function archive() {
  return [
    {
      $top: { root: { UID: 1 } },
      $objects: [
        "$null",
        { richLinkMetadata: { UID: 2 } },
        { URL: { UID: 3 }, title: { UID: 4 }, summary: { UID: 5 } },
        "https://public.example.test/article",
        "Fictional article",
        "Fictional summary",
      ],
    },
  ];
}

describe("ManagedLinkPreviewEnricher", () => {
  it("prefers normalized BlueBubbles payloadData", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { payloadData: archive() } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const openGraphFetch = vi.fn();
    const openGraph = { fetch: openGraphFetch } as unknown as OpenGraphClient;
    const enricher = new ManagedLinkPreviewEnricher(
      settings({}),
      openGraph,
      fetchImplementation,
    );

    await expect(enricher.enrich(envelope)).resolves.toMatchObject({
      linkPreview: {
        status: "available",
        items: [
          {
            source: "bluebubbles",
            title: "Fictional article",
            summary: "Fictional summary",
          },
        ],
      },
      diagnostics: [{ source: "bluebubbles", attempt: 1, status: "succeeded" }],
    });
    expect(openGraphFetch).not.toHaveBeenCalled();
  });

  it("falls back to Open Graph after a non-retryable BlueBubbles response", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 400 })),
    );
    const openGraphFetch = vi.fn(() =>
      Promise.resolve({
        source: "open-graph" as const,
        url: "https://public.example.test/article",
        originalUrl: "https://public.example.test/article",
        title: "Fallback title",
        summary: null,
        siteName: "Example Test",
        imageAvailable: false,
        iconAvailable: true,
      }),
    );
    const openGraph = {
      fetch: openGraphFetch,
    } as unknown as OpenGraphClient;
    const enricher = new ManagedLinkPreviewEnricher(
      settings({}),
      openGraph,
      fetchImplementation,
    );

    const result = await enricher.enrich(envelope);
    expect(result.linkPreview).toMatchObject({
      status: "available",
      items: [{ source: "open-graph", title: "Fallback title" }],
    });
    expect(result.diagnostics).toMatchObject([
      { source: "bluebubbles", status: "failed", httpStatus: 400 },
      { source: "open-graph", status: "succeeded", httpStatus: 200 },
    ]);
    expect(openGraphFetch).toHaveBeenCalledWith(
      "https://public.example.test/article",
      1_000,
    );
  });

  it("does no collection when link previews are disabled", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const openGraphFetch = vi.fn();
    const openGraph = { fetch: openGraphFetch } as unknown as OpenGraphClient;
    const enricher = new ManagedLinkPreviewEnricher(
      settings({ linkPreviewEnabled: false }),
      openGraph,
      fetchImplementation,
    );

    await expect(enricher.enrich(envelope)).resolves.toEqual({
      linkPreview: {
        status: "not-requested",
        errorCode: null,
        items: [],
      },
      diagnostics: [],
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(openGraphFetch).not.toHaveBeenCalled();
  });
});
