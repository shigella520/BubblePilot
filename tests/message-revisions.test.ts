import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import {
  ManagedMessageDetailClient,
  parseMessageDetail,
} from "../modules/integrations/bluebubbles/message-detail.js";
import type { BlueBubblesSettingsService } from "../modules/integrations/bluebubbles/settings-service.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";
import { revisionLimits } from "../modules/archive/message-revision.js";

const detail = (overrides: Record<string, unknown> = {}) => ({
  guid: "fictional-message",
  text: "改为十点",
  dateEdited: 1788000001000,
  partCount: 1,
  messageSummaryInfo: [{ retractedParts: [] }],
  attachments: [],
  chats: [{ guid: "fictional-chat" }],
  ...overrides,
});
describe("message revision transport", () => {
  const adapter = new BlueBubblesWebhookAdapter();
  it("accepts content notifications without chats and ignores delivery-only updates", () => {
    expect(
      adapter.normalize(
        {
          type: "updated-message",
          data: { guid: "fictional", dateEdited: 1000 },
        },
        randomUUID(),
      ).kind,
    ).toBe("revision");
    expect(
      adapter.normalize(
        {
          type: "updated-message",
          data: { guid: "fictional", dateRead: 1000 },
        },
        randomUUID(),
      ).kind,
    ).toBe("ignored");
  });
  it("deduplicates by content version, not delivery/read timestamps", () => {
    const a = adapter.normalize(
      {
        type: "updated-message",
        data: { guid: "fictional", dateEdited: 1000, dateRead: 1100 },
      },
      randomUUID(),
    );
    const b = adapter.normalize(
      {
        type: "updated-message",
        data: { guid: "fictional", dateEdited: 1000, dateRead: 1200 },
      },
      randomUUID(),
    );
    expect(
      a.kind === "revision" &&
        b.kind === "revision" &&
        a.notification.eventId === b.notification.eventId,
    ).toBe(true);
  });
  it("preserves quotes without treating them as another event", () => {
    const input = newMessageWebhook();
    const result = adapter.normalize(
      {
        ...input,
        data: { ...input.data, threadOriginatorGuid: "fictional-original" },
      },
      randomUUID(),
    );
    expect(
      result.kind === "message" && result.envelope.message.replyReference,
    ).toEqual({ targetGuid: "fictional-original", part: null });
  });
  it("does not mistake empty text for unsend; does not persist edit history", () => {
    const result = parseMessageDetail(
      detail({
        text: "",
        messageSummaryInfo: [
          { retractedParts: [], history: "fictional old text" },
        ],
      }),
    );
    expect(result.state).toBe("active");
    expect(JSON.stringify(result)).not.toContain("fictional old text");
  });
  it("distinguishes full unsend, partial unsend and insufficient detail", () => {
    expect(
      parseMessageDetail(
        detail({ partCount: 0, messageSummaryInfo: [{ retractedParts: [0] }] }),
      ).state,
    ).toBe("retracted");
    const partial = parseMessageDetail(
      detail({ messageSummaryInfo: [{ retractedParts: [1] }] }),
    );
    expect(partial).toMatchObject({
      state: "partial",
      text: null,
      attachments: [],
    });
    expect(parseMessageDetail(detail({ messageSummaryInfo: null })).state).toBe(
      "unresolved",
    );
  });
  it("bounds REST reads, rejects redirects/mismatched GUIDs and does not log credentials", async () => {
    const settings = {
      resolve: () =>
        Promise.resolve({
          serverUrl: "https://gateway.example.test",
          accessToken: "fictional-token",
          requestTimeoutMs: 1000,
        }),
    } as unknown as BlueBubblesSettingsService;
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ data: detail() }))),
    );
    const client = new ManagedMessageDetailClient(settings, request);
    await client.read("fictional-message");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    await expect(client.read("different-message")).rejects.toThrow(
      "MESSAGE_DETAIL_UNAVAILABLE",
    );
    const oversized = new ManagedMessageDetailClient(settings, () =>
      Promise.resolve(
        new Response("x".repeat(revisionLimits.responseBytes + 1)),
      ),
    );
    await expect(oversized.read("fictional-message")).rejects.toThrow(
      "MESSAGE_DETAIL_UNAVAILABLE",
    );
  });
  it("coalesces same-target reads, caps concurrent details and releases timed out calls", async () => {
    const settings = {
      resolve: () =>
        Promise.resolve({
          serverUrl: "https://gateway.example.test",
          accessToken: "fictional-token",
          requestTimeoutMs: 1000,
        }),
    } as unknown as BlueBubblesSettingsService;
    const finish: Array<() => void> = [];
    const request = vi.fn<typeof fetch>(
      (url) =>
        new Promise<Response>((resolve) => {
          const guid = decodeURIComponent(
            new URL(url instanceof Request ? url.url : url).pathname
              .split("/")
              .at(-1)!,
          );
          finish.push(() =>
            resolve(new Response(JSON.stringify({ data: detail({ guid }) }))),
          );
        }),
    );
    const client = new ManagedMessageDetailClient(settings, request);
    const first = client.read("same");
    expect(client.read("same")).toBe(first);
    const pending = [
      first,
      ...["two", "three", "four"].map((guid) => client.read(guid)),
    ];
    await expect(client.read("fifth")).rejects.toThrow("MESSAGE_DETAIL_BUSY");
    for (const complete of finish) complete();
    await Promise.all(pending);
    expect(request).toHaveBeenCalledTimes(4);
    const timeoutSettings = {
      resolve: () =>
        Promise.resolve({
          serverUrl: "https://gateway.example.test",
          accessToken: "fictional-token",
          requestTimeoutMs: 5,
        }),
    } as unknown as BlueBubblesSettingsService;
    const aborting = new ManagedMessageDetailClient(
      timeoutSettings,
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () =>
              reject(new Error("fictional upstream secret must not escape")),
            { once: true },
          );
        }),
    );
    await expect(aborting.read("same")).rejects.toThrow(
      "MESSAGE_DETAIL_UNAVAILABLE",
    );
    await expect(aborting.read("same")).rejects.toThrow(
      "MESSAGE_DETAIL_UNAVAILABLE",
    );
  });
});
