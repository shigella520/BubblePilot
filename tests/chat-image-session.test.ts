import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ChatImageSourceRepository } from "../modules/ai/chat-image-source.js";
import { NativeImageInputService } from "../modules/ai/native-image-input.js";
import type { ImageInputSettingsService } from "../modules/ai/image-input-settings-service.js";
import type { BlueBubblesSettingsService } from "../modules/integrations/bluebubbles/settings-service.js";
import { AgentToolRegistry } from "../modules/ai/agent-tool-registry.js";
import type { ImageInputRuntimeSettings } from "../modules/ai/image-input-settings-types.js";
import type { MessageEnvelope } from "../modules/ingestion/message-envelope.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";
import { AgentRunner } from "../modules/ai/agent-runner.js";
import type { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import type { AiRouteRequest } from "../modules/ai/ai-types.js";

function parseResult(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=",
  "base64",
);
const settings: ImageInputRuntimeSettings = {
  enabled: true,
  includeAttachments: true,
  includeLinkPreviewImages: false,
  trustedLinkPreviewHosts: [],
  maxCurrentAttachments: 4,
  maxHistoryImages: 2,
  maxTotalImages: 6,
  maxImageBytes: 10485760,
  maxTotalBytes: 20971520,
  fetchTimeoutMs: 15000,
  detail: "auto",
};
const attachment = {
  providerAttachmentId: "fictional-menu",
  mimeType: "image/png",
  fileName: "menu.png",
  sizeBytes: png.length,
};
const envelope: MessageEnvelope = {
  schemaVersion: "3",
  eventId: "fictional-event",
  correlationId: randomUUID(),
  provider: "bluebubbles",
  chat: {
    providerChatId: "fictional-chat",
    type: "group",
    displayName: "虚构餐厅群",
  },
  message: {
    providerMessageId: "fictional-message",
    senderId: "fictional-person",
    sentAt: "2026-09-01T00:00:00Z",
    text: "菜单有什么？",
    contentType: "mixed",
    isFromMe: false,
    attachments: [attachment],
    linkPreview: { status: "not-requested", errorCode: null, items: [] },
    contentHash: "fictional-hash",
  },
  metadata: {
    isReplay: false,
    payloadHash: "fictional",
    eventType: "new-message",
    adapterVersion: "1",
  },
};
function fixture(overrides: Partial<ImageInputRuntimeSettings> = {}) {
  const resolved = { ...settings, ...overrides };
  const repository = new InMemoryAiRepository();
  const sources = new ChatImageSourceRepository({} as Pool);
  const resolve = vi.spyOn(sources, "resolve").mockResolvedValue({
    messageId: "11111111-1111-4111-8111-111111111111",
    providerMessageId: envelope.message.providerMessageId,
    attachment,
    attachmentIndex: 0,
  });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(new Response(png)));
  const loader = new NativeImageInputService(
    { resolve: () => Promise.resolve(resolved) } as ImageInputSettingsService,
    {
      resolve: () =>
        Promise.resolve({
          serverUrl: "https://gateway.example.test",
          accessToken: "fictional",
        }),
    } as BlueBubblesSettingsService,
    repository,
    fetcher,
    sources,
  );
  const input = {
    executionId: randomUUID(),
    nodeId: "ai",
    envelope,
    history: [],
    prepared: {
      settings: resolved,
      parts: [],
      items: [],
      selectedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      totalBytes: 0,
    },
  };
  const session = loader.createSession(input)!;
  const registry = new AgentToolRegistry();
  const capable = vi.fn(() => Promise.resolve(true));
  session?.register(registry, capable);
  const context = {
    signal: new AbortController().signal,
    deadline: Date.now() + 10000,
    maxOutputCharacters: 24000,
  };
  const invoke = async (args: string) => {
    const output = await registry
      .get("view_chat_image")!
      .execute(args, context);
    if (typeof output === "string") throw new Error("Expected staged image");
    return output;
  };
  return {
    session,
    repository,
    resolve,
    fetcher,
    loader,
    input,
    registry,
    capable,
    context,
    invoke,
    ref: session?.references()[0]?.image_ref,
  };
}
describe("runtime chat image access", () => {
  it("registers only with both existing input switches enabled", () => {
    expect(fixture({ enabled: false }).session).toBeUndefined();
    expect(
      fixture({ includeAttachments: false }).registry.definitions(),
    ).toEqual([]);
  });
  it("seeds the shared budget from automatic inputs and verifies historic preview hashes", async () => {
    const f = fixture({ maxTotalImages: 1 });
    const prepared = await f.loader.prepare({
      ...f.input,
      includeHistory: false,
    });
    const session = f.loader.createSession({ ...f.input, prepared })!;
    expect(session.snapshot()).toMatchObject({
      automatic: 1,
      tool: 0,
      count: { used: 1 },
      bytes: { used: png.length },
    });
    const record = (
      await f.repository.listImageInputs(f.input.executionId)
    )[0]!;
    expect(prepared.parts[0]?.imageInput?.imageInputId).toBe(record.id);
    expect(
      await f.loader.preview(record.diagnostics!, record.sourceHash),
    ).not.toBeNull();
    expect(
      await f.loader.preview(
        { ...record.diagnostics!, contentHash: "wrong-hash" },
        record.sourceHash,
      ),
    ).toBeNull();
    f.resolve.mockResolvedValue(null);
    expect(await session.validate()).toBe(false);
    expect(
      await f.loader.preview(record.diagnostics!, record.sourceHash),
    ).toBeNull();
  });
  it("stages pictures, commits once and reuses without charging image bytes twice", async () => {
    const f = fixture();
    const result = await f.invoke(JSON.stringify({ image_ref: f.ref }));
    expect(parseResult(result.text).status).toBe("loaded");
    expect(f.session.snapshot().count.used).toBe(0);
    expect(result.commit!()).not.toBeNull();
    await f.session.flushAudit();
    expect(f.session.snapshot()).toMatchObject({
      count: { used: 1 },
      bytes: { used: png.length },
      automatic: 0,
      tool: 1,
    });
    const repeat = await f.invoke(JSON.stringify({ image_ref: f.ref }));
    expect(parseResult(repeat.text).status).toBe("already-loaded");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.session.drain()).toHaveLength(1);
    const records = await f.repository.listImageInputs(f.input.executionId);
    expect(records[0]?.diagnostics).toMatchObject({
      version: 1,
      trigger: "tool",
      width: 1,
      height: 1,
    });
    expect(JSON.stringify(records)).not.toContain("base64");
    expect(
      new URL(f.fetcher.mock.calls[0]![0] as URL).searchParams.get("original"),
    ).toBe("false");
  });
  it("rejects guessed, cross-run and malformed refs without gateway calls", async () => {
    const f = fixture();
    for (const args of [
      "{}",
      '{"image_ref":"https://bad.example"}',
      JSON.stringify({ image_ref: fixture().ref }),
      JSON.stringify({ image_ref: f.ref, url: "bad" }),
    ]) {
      expect(parseResult((await f.invoke(args)).text).status).not.toBe(
        "loaded",
      );
    }
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("shares automatic totals and does not apply historical auto count to tools", async () => {
    const f = fixture({ maxHistoryImages: 0, maxTotalImages: 1 });
    f.session.registerHistory([
      {
        image_ref: "I-history",
        providerMessageId: "fictional-old",
        attachmentIndex: 0,
        attachmentId: attachment.providerAttachmentId,
      },
    ]);
    const result = await f.invoke('{"image_ref":"I-history"}');
    result.commit!();
    expect(f.resolve).toHaveBeenCalledWith(
      expect.anything(),
      "fictional-old",
      0,
      true,
    );
    expect(
      parseResult((await f.invoke(JSON.stringify({ image_ref: f.ref }))).text)
        .reason,
    ).toBe("image-budget");
  });
  it("refuses missing capability, revoked access and changed attachments", async () => {
    const f = fixture();
    f.capable.mockResolvedValueOnce(false);
    expect(
      parseResult((await f.invoke(JSON.stringify({ image_ref: f.ref }))).text)
        .reason,
    ).toBe("image-capability-unavailable");
    f.resolve.mockResolvedValueOnce(null);
    expect(
      parseResult((await f.invoke(JSON.stringify({ image_ref: f.ref }))).text)
        .reason,
    ).toBe("source-unavailable");
    f.resolve
      .mockResolvedValueOnce({
        messageId: "11111111-1111-4111-8111-111111111111",
        providerMessageId: envelope.message.providerMessageId,
        attachment,
        attachmentIndex: 0,
      })
      .mockResolvedValueOnce(null);
    const output = await f.invoke(JSON.stringify({ image_ref: f.ref }));
    expect(parseResult(output.text).reason).toBe("source-unavailable");
    expect(output.commit).toBeUndefined();
    expect(f.session.snapshot().count.used).toBe(0);
  });
  it("does not submit an image if text or byte budgets cannot fit", async () => {
    const f = fixture();
    f.context.maxOutputCharacters = 10;
    const output = await f.invoke(JSON.stringify({ image_ref: f.ref }));
    expect(parseResult(output.text).reason).toBe("tool-output");
    expect(output.commit).toBeUndefined();
    const g = fixture({ maxTotalBytes: 1 });
    expect(
      parseResult((await g.invoke(JSON.stringify({ image_ref: g.ref }))).text)
        .reason,
    ).toBe("image-budget");
    expect(g.session.snapshot().count.used).toBe(0);
  });
  it("isolates a downloader ignoring cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.context.signal = controller.signal;
    let finish: (value: Response) => void = () => {};
    f.fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const output = f.invoke(JSON.stringify({ image_ref: f.ref }));
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled());
    controller.abort();
    finish(new Response(png));
    await expect(output).rejects.toThrow();
    expect(f.session.snapshot().count.used).toBe(0);
    expect(f.session.drain()).toEqual([]);
  });
  it("pairs a batch before multimodal references and retains schemas after exhaustion", async () => {
    const f = fixture();
    const requests: AiRouteRequest[] = [];
    const routing = {
      supportsImageTools: () => Promise.resolve(true),
      execute: (request: AiRouteRequest) => {
        requests.push(request);
        return Promise.resolve({
          status: "succeeded" as const,
          text: requests.length === 1 ? "" : "虚构菜单已核对",
          providerId: "fictional-provider",
          model: "fictional",
          attemptCount: 1,
          durationMs: 1,
          toolCalls:
            requests.length === 1
              ? [
                  {
                    id: "image1",
                    name: "view_chat_image",
                    arguments: JSON.stringify({ image_ref: f.ref }),
                  },
                  {
                    id: "image2",
                    name: "view_chat_image",
                    arguments: JSON.stringify({ image_ref: f.ref }),
                  },
                ]
              : [],
        });
      },
    } as unknown as AiRoutingService;
    const result = await new AgentRunner(
      routing,
      undefined,
      f.repository,
      undefined,
      {
        maxToolCalls: 2,
        maxToolOutputCharacters: 24000,
        maxToolDurationMs: 60000,
      },
    ).run({
      executionId: f.input.executionId,
      nodeId: "ai",
      routeId: "fictional-route",
      imageSession: f.session,
      messages: [{ role: "user", content: "核对菜单" }],
      maxOutputTokens: 1000,
      maxOutputCharacters: 3000,
      temperature: null,
      outputFormat: "text",
      protectedPrompt: null,
    });
    expect(result.status).toBe("succeeded");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.tools).toEqual(requests[0]!.tools);
    expect(requests[1]!.allowImageDegrade).toBe(false);
    const roles = requests[1]!.messages.map((m) => m.role);
    const firstTool = roles.indexOf("tool");
    expect(roles.slice(firstTool, firstTool + 3)).toEqual([
      "tool",
      "tool",
      "user",
    ]);
    expect(result.agentBudget).toMatchObject({
      toolCalls: 2,
      images: { count: { used: 1 }, tool: 1 },
    });
  });
});
