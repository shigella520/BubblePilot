import { it, expect, vi } from "vitest";
import { BlueBubblesRestReplyGateway } from "../modules/integrations/bluebubbles/rest-reply-gateway.js";
const command = {
  providerChatId: "fictional-chat",
  providerTempGuid: "stable-temp",
  idempotencyKey: "test-key",
  correlationId: "test",
  filename: "test.gif",
  mimeType: "image/gif",
  bytes: Buffer.from("fictional"),
};
it("sends original attachment in AppleScript multipart without native reply parameters", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ data: { guid: "fictional-guid", error: 0 } }),
        { status: 200 },
      ),
    );
  const gateway = new BlueBubblesRestReplyGateway({
    serverUrl: "https://gateway.example",
    accessToken: "fictional",
    method: "private-api",
    timeoutMs: 1000,
    fetchImplementation: fetcher,
  });
  expect(await gateway.sendAttachment(command)).toMatchObject({
    status: "confirmed",
  });
  const form = fetcher.mock.calls[0]?.[1]?.body as FormData;
  expect(form.get("method")).toBe("apple-script");
  expect(form.get("tempGuid")).toBe("stable-temp");
  expect(form.has("selectedMessageGuid")).toBe(false);
  expect(
    Buffer.from(await (form.get("attachment") as Blob).arrayBuffer()),
  ).toEqual(command.bytes);
});
it("does not treat an ambiguous 200 or server failure as confirmed", async () => {
  for (const response of [
    new Response("{}", { status: 200 }),
    new Response("error", { status: 500 }),
  ]) {
    const gateway = new BlueBubblesRestReplyGateway({
      serverUrl: "https://gateway.example",
      accessToken: "fictional",
      method: "apple-script",
      timeoutMs: 1000,
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(response),
    });
    expect((await gateway.sendAttachment(command)).status).toBe("unknown");
  }
});
