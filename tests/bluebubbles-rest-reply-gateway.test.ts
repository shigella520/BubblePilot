import { describe, expect, it, vi } from "vitest";

import { BlueBubblesRestReplyGateway } from "../modules/integrations/bluebubbles/rest-reply-gateway.js";

const command = {
  providerChatId: "iMessage;-;fictional-chat",
  text: "Fictional reply",
  replyToProviderMessageId: "fictional-source-message",
  idempotencyKey: "fictional-execution:reply",
  providerTempGuid: "ca3858f6-971f-40db-999f-a647f2ec9922",
  correlationId: "8e54799b-96cb-40cf-9df4-9331c8903728",
};

describe("BlueBubblesRestReplyGateway", () => {
  it("sends the BlueBubbles text contract and confirms the provider id", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: { guid: "fictional-outbound-guid" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const gateway = new BlueBubblesRestReplyGateway({
      serverUrl: "https://bluebubbles.example.test",
      accessToken: "fictional-token",
      method: "private-api",
      timeoutMs: 5_000,
      fetchImplementation,
    });

    await expect(gateway.sendReply(command)).resolves.toEqual({
      status: "confirmed",
      providerMessageId: "fictional-outbound-guid",
    });
    const [url, options] = fetchImplementation.mock.calls[0] ?? [];
    const urlText =
      url instanceof URL
        ? url.toString()
        : typeof url === "string"
          ? url
          : url?.url;
    expect(urlText).toBe(
      "https://bluebubbles.example.test/api/v1/message/text?password=fictional-token",
    );
    expect(typeof options?.body).toBe("string");
    const requestBody: unknown =
      typeof options?.body === "string" ? JSON.parse(options.body) : null;
    expect(requestBody).toMatchObject({
      chatGuid: command.providerChatId,
      message: command.text,
      method: "private-api",
      tempGuid: command.providerTempGuid,
      selectedMessageGuid: command.replyToProviderMessageId,
      partIndex: 0,
    });
  });

  it("classifies rate limits as retryable and network ambiguity as unknown", async () => {
    const rateLimited = new BlueBubblesRestReplyGateway({
      serverUrl: "https://bluebubbles.example.test",
      accessToken: "fictional-token",
      method: "private-api",
      timeoutMs: 5_000,
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 429 })),
    });
    await expect(rateLimited.sendReply(command)).resolves.toMatchObject({
      status: "failed",
      code: "BLUEBUBBLES_RATE_LIMITED",
      retryable: true,
    });

    const unknown = new BlueBubblesRestReplyGateway({
      serverUrl: "https://bluebubbles.example.test",
      accessToken: "fictional-token",
      method: "private-api",
      timeoutMs: 5_000,
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new TypeError("fictional network failure")),
    });
    await expect(unknown.sendReply(command)).resolves.toMatchObject({
      status: "unknown",
      code: "BLUEBUBBLES_REPLY_RESULT_UNKNOWN",
    });
  });
});
