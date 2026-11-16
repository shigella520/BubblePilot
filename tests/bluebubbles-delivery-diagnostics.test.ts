import { afterEach, describe, expect, it, vi } from "vitest";
import { BlueBubblesRestReplyGateway } from "../modules/integrations/bluebubbles/rest-reply-gateway.js";
import type { DeliveryDiagnosticSink } from "../modules/integrations/bluebubbles/delivery-diagnostics.js";
import { ManagedBlueBubblesReplyGateway } from "../modules/integrations/bluebubbles/managed-reply-gateway.js";
import { BlueBubblesSettingsService } from "../modules/integrations/bluebubbles/settings-service.js";
import { SettingsCipher } from "../modules/integrations/bluebubbles/settings-cipher.js";

const command = {
  providerChatId: "fictional-private-chat",
  text: "fictional-private-message",
  replyToProviderMessageId: "fictional-private-source",
  idempotencyKey: "fictional-execution:reply",
  providerTempGuid: "ca3858f6-971f-40db-999f-a647f2ec9922",
  correlationId: "8e54799b-96cb-40cf-9df4-9331c8903728",
  filename: "fictional-private-filename.pdf",
  mimeType: "application/pdf",
  bytes: Buffer.from("fictional-private-file-content"),
};
const privateData =
  "https://gateway.example.test?password=fictional-secret private-response";

function setup(
  fetchImplementation: typeof fetch,
  sink = vi.fn<DeliveryDiagnosticSink>(),
) {
  const gateway = new BlueBubblesRestReplyGateway({
    serverUrl: "https://gateway.example.test",
    accessToken: "fictional-secret",
    method: "private-api",
    timeoutMs: 30_000,
    fetchImplementation,
    onDiagnostic: sink,
  });
  return { gateway, sink };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

for (const kind of ["text", "attachment"] as const) {
  describe(`${kind} delivery diagnostics`, () => {
    const send = (gateway: BlueBubblesRestReplyGateway) =>
      kind === "text"
        ? gateway.sendReply(command)
        : gateway.sendAttachment(command);

    it("records transport causes without copying sensitive exception fields", async () => {
      const nested = Object.assign(new Error(privateData), {
        code: "ECONNRESET",
        address: "private-host",
      });
      const failure = new TypeError(privateData, {
        cause: new AggregateError([nested], privateData),
      });
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(failure);
      const { gateway, sink } = setup(fetcher);
      expect((await send(gateway)).status).toBe("unknown");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledWith(
        expect.objectContaining({
          kind,
          stage: "request",
          httpStatus: null,
          errorName: "TypeError",
          causeCodes: ["ECONNRESET"],
          correlationId: command.correlationId,
          providerTempGuid: command.providerTempGuid,
          timeoutMs: 30_000,
          timedOut: false,
        }),
      );
      const logged = JSON.stringify(sink.mock.calls);
      for (const secret of [
        privateData,
        command.text,
        command.providerChatId,
        command.filename,
        command.bytes.toString(),
        "fictional-secret",
        "private-host",
        command.idempotencyKey,
      ])
        expect(logged).not.toContain(secret);
    });

    it("separates a successful HTTP status with invalid JSON from a network failure", async () => {
      const { gateway, sink } = setup(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(privateData, { status: 200 })),
      );
      expect((await send(gateway)).status).toBe("unknown");
      expect(sink).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "response-json",
          httpStatus: 200,
          responseBytes: Buffer.byteLength(privateData),
          errorName: "SyntaxError",
        }),
      );
      expect(JSON.stringify(sink.mock.calls)).not.toContain(privateData);
    });

    it("distinguishes an interrupted response body", async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.error(
            Object.assign(new TypeError(privateData), {
              cause: { code: "UND_ERR_SOCKET" },
            }),
          );
        },
      });
      const { gateway, sink } = setup(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(body, { status: 200 })),
      );
      expect((await send(gateway)).status).toBe("unknown");
      expect(sink).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "response-body",
          httpStatus: 200,
          responseBytes: null,
          causeCodes: ["UND_ERR_SOCKET"],
        }),
      );
    });

    it.each([429, 503])(
      "logs HTTP %s without reading the response body",
      async (status) => {
        const response = new Response(privateData, { status });
        const { gateway, sink } = setup(
          vi.fn<typeof fetch>().mockResolvedValue(response),
        );
        const result = await send(gateway);
        expect(result.status).toBe(
          kind === "attachment" && status === 503 ? "unknown" : "failed",
        );
        expect(response.bodyUsed).toBe(false);
        expect(sink).toHaveBeenCalledWith(
          expect.objectContaining({
            stage: "http-status",
            httpStatus: status,
            errorName: null,
            responseBytes: null,
          }),
        );
      },
    );

    it("records actual timeout without retrying", async () => {
      vi.useFakeTimers();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException(privateData, "AbortError")),
              { once: true },
            );
          }),
      );
      const { gateway, sink } = setup(fetcher);
      const result = send(gateway);
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await result).status).toBe("unknown");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "request",
          timedOut: true,
          errorName: "AbortError",
        }),
      );
    });

    it("preserves receipt semantics and reports missing guid", async () => {
      const { gateway, sink } = setup(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("{}", { status: 200 })),
      );
      expect((await send(gateway)).status).toBe(
        kind === "text" ? "confirmed" : "unknown",
      );
      expect(sink).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "receipt",
          httpStatus: 200,
          responseBytes: 2,
        }),
      );
    });

    it("does not emit diagnostics on a normal confirmed delivery", async () => {
      const { gateway, sink } = setup(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(JSON.stringify({ data: { guid: "fictional-guid" } })),
          ),
      );
      expect((await send(gateway)).status).toBe("confirmed");
      expect(sink).not.toHaveBeenCalled();
    });

    it("does not let logging failures change delivery results", async () => {
      const sink = vi.fn<DeliveryDiagnosticSink>().mockImplementation(() => {
        throw new Error("fictional log failure");
      });
      const { gateway } = setup(
        vi.fn<typeof fetch>().mockRejectedValue(new TypeError(privateData)),
        sink,
      );
      expect((await send(gateway)).status).toBe("unknown");
      expect(sink).toHaveBeenCalledTimes(1);
    });
  });
}

it("drops untrusted error names/codes and handles cyclic causes", async () => {
  const error = Object.assign(new Error(privateData), {
    name: privateData,
    code: privateData,
    cause: {},
  });
  error.cause = error;
  const { gateway, sink } = setup(
    vi.fn<typeof fetch>().mockRejectedValue(error),
  );
  await gateway.sendReply({
    ...command,
    correlationId: privateData,
    providerTempGuid: privateData,
  });
  expect(sink).toHaveBeenCalledWith(
    expect.objectContaining({
      errorName: "Other",
      causeCodes: [],
      correlationId: null,
      providerTempGuid: null,
    }),
  );
  expect(JSON.stringify(sink.mock.calls)).not.toContain(privateData);
});

it("records attachment rejection without dumping the provider response", async () => {
  const { gateway, sink } = setup(
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { guid: "fictional-guid", error: 1, detail: privateData },
        }),
      ),
    ),
  );
  expect(await gateway.sendAttachment(command)).toMatchObject({
    status: "failed",
    code: "BLUEBUBBLES_ATTACHMENT_REJECTED",
    retryable: false,
  });
  expect(sink).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "attachment",
      stage: "receipt",
      code: "BLUEBUBBLES_ATTACHMENT_REJECTED",
    }),
  );
  expect(JSON.stringify(sink.mock.calls)).not.toContain(privateData);
});

it("passes diagnostics through the runtime settings gateway for both send paths", async () => {
  const settings = new BlueBubblesSettingsService(
    {
      find: () => Promise.resolve(null),
      save: () => Promise.resolve({ status: "conflict" as const }),
      isReady: () => Promise.resolve(true),
      close: () => Promise.resolve(),
    },
    new SettingsCipher("fictional-settings-secret"),
    {
      serverUrl: "https://gateway.example.test",
      accessToken: "fictional-secret",
      webhookSecret: "fictional-webhook-secret",
      sendMethod: "private-api",
      requestTimeoutMs: 12_000,
      linkPreviewEnabled: false,
      openGraphFallbackEnabled: false,
      openGraphTimeoutMs: 5_000,
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockRejectedValue(new TypeError(privateData)),
  );
  const sink = vi.fn<DeliveryDiagnosticSink>();
  const gateway = new ManagedBlueBubblesReplyGateway(settings, sink);
  await gateway.sendReply(command);
  await gateway.sendAttachment(command);
  expect(sink).toHaveBeenCalledTimes(2);
  expect(sink.mock.calls[0]?.[0]).toMatchObject({
    kind: "text",
    method: "private-api",
    timeoutMs: 12_000,
  });
  expect(sink.mock.calls[1]?.[0]).toMatchObject({
    kind: "attachment",
    method: "apple-script",
    timeoutMs: 12_000,
  });
});
