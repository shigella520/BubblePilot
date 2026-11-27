import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  AttachmentSession,
  attachmentGuidanceFor,
  type AttachmentRunInput,
} from "../modules/attachments/attachment-session.js";
import { generatorImportPlan } from "../modules/attachments/attachment-format.js";
import { AttachmentStore } from "../modules/attachments/attachment-store.js";
import { attachmentLimitsSchema } from "../modules/attachments/attachment-policy.js";
import {
  GeneratedImageSession,
  replyAttachmentGuidance,
  imageReplyGuidance,
} from "../modules/generated-images/image-session.js";
import type {
  GeneratedImageStore,
  ImageArtifact,
} from "../modules/generated-images/image-store.js";
import { AgentToolRegistry } from "../modules/ai/agent-tool-registry.js";
import type { PluginSession } from "../modules/plugins/plugin-session.js";
import { parseWorkflowDefinition } from "../modules/workflow/workflow-definition.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const ctx = () => ({
  signal: AbortSignal.timeout(5000),
  deadline: Date.now() + 5000,
  maxOutputCharacters: 64000,
});
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const csv = Buffer.from("a,b\n1,2\n");

describe("generator import plan", () => {
  const types = ["image/png", "image/jpeg", "image/webp"];
  it("imports accepted originals and converts HEIC through the gateway", () => {
    expect(
      generatorImportPlan(
        {
          providerAttachmentId: "x",
          fileName: "猫.PNG",
          mimeType: "image/png",
          sizeBytes: 1,
        },
        types,
      ),
    ).toEqual({ filename: "猫.png", extension: "png", original: true });
    expect(
      generatorImportPlan(
        {
          providerAttachmentId: "x",
          fileName: "IMG_0001.HEIC",
          mimeType: "image/heic",
          sizeBytes: 1,
        },
        types,
      ),
    ).toEqual({
      filename: "IMG_0001.jpeg",
      extension: "jpeg",
      original: false,
    });
  });
  it("rejects other files, conflicting types and unsupported conversions", () => {
    for (const attachment of [
      { fileName: "report.pdf", mimeType: "application/pdf" },
      { fileName: "anim.gif", mimeType: "image/gif" },
      { fileName: "fake.png", mimeType: "image/heic" },
    ])
      expect(() =>
        generatorImportPlan(
          { providerAttachmentId: "x", sizeBytes: 1, ...attachment },
          types,
        ),
      ).toThrow("ATTACHMENT_TYPE_UNSUPPORTED_FOR_TARGET");
    expect(() =>
      generatorImportPlan(
        {
          providerAttachmentId: "x",
          fileName: "a.heic",
          mimeType: "image/heic",
          sizeBytes: 1,
        },
        ["image/png"],
      ),
    ).toThrow("ATTACHMENT_TYPE_UNSUPPORTED_FOR_TARGET");
  });
});

async function attachmentFixture(withSandbox: boolean) {
  const root = await mkdtemp(join(tmpdir(), "bp-generator-unit-"));
  roots.push(root);
  const storage = new AttachmentStore(root);
  await storage.init();
  const attachments = [
    {
      providerAttachmentId: "photo",
      fileName: "IMG_0001.HEIC",
      mimeType: "image/heic",
      sizeBytes: null,
    },
    {
      providerAttachmentId: "sheet",
      fileName: "data.csv",
      mimeType: "text/csv",
      sizeBytes: null,
    },
    // iPhone photo labelled JPEG whose gateway original is HEIC.
    {
      providerAttachmentId: "labelled",
      fileName: "IMG_0002.jpeg",
      mimeType: "image/jpeg",
      sizeBytes: null,
    },
    {
      providerAttachmentId: "real",
      fileName: "real.jpeg",
      mimeType: "image/jpeg",
      sizeBytes: null,
    },
  ];
  const heif = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from("ftypheic\0\0\0\0mif1heic", "latin1"),
    Buffer.alloc(64),
  ]);
  const download = vi.fn(
    (id: string, _signal: AbortSignal, options?: { original?: boolean }) =>
      Promise.resolve(
        new Response(
          id === "sheet"
            ? csv
            : id === "labelled" && options?.original !== false
              ? heif
              : jpeg,
        ),
      ),
  );
  const channel = (server: string, prefix: string) => ({
    metadata: { pluginId: randomUUID(), server },
    check: vi.fn(async () => {}),
    invalidate: vi.fn(async () => {}),
    transfer: vi.fn((input: Record<string, unknown>) =>
      Promise.resolve({
        status: "imported",
        sandbox_path: `${prefix}attachments/${String(input.id)}/${String(input.filename)}`,
        size: input.size,
        sha256: input.sha256,
      }),
    ),
  });
  const sandbox = channel("sandbox", "/workspace/");
  const generator = channel("image", "/workspace/image-gen/");
  const plugins = {
    attachmentChannel: () => sandbox,
    generatorChannels: () => ({
      workspacePrefix: "/workspace/image-gen/",
      mimeTypes: ["image/png", "image/jpeg", "image/webp"],
      attachment: generator,
      export: {
        check: vi.fn(),
        export: vi.fn(),
        workspacePrefix: "/workspace/image-gen/",
      },
    }),
  } as unknown as PluginSession;
  const input: AttachmentRunInput = {
    ...(withSandbox
      ? {
          config: {
            enabled: true,
            pluginId: sandbox.metadata.pluginId,
            server: "sandbox",
            limits: attachmentLimitsSchema.parse({}),
          },
        }
      : {}),
    generator: { pluginId: generator.metadata.pluginId, server: "image" },
    scope: {
      provider: "bluebubbles",
      providerChatId: "fictional-chat",
      triggerMessageId: "current",
    },
    current: { providerMessageId: "current", attachments },
  };
  const session = new AttachmentSession(
    input,
    plugins,
    {
      resolve: (_scope, _message, index) =>
        Promise.resolve({
          messageId: "archive-message",
          providerMessageId: "current",
          attachment: attachments[index]!,
          attachmentIndex: index,
        }),
    },
    { download },
    storage,
  );
  const listing = session.currentCatalogue();
  const refs = listing.entries.map((e) => e.attachment_ref!);
  const registry = new AgentToolRegistry();
  session.register(registry);
  const tool = registry.get("import_chat_attachment")!;
  const call = async (args: Record<string, unknown>) =>
    JSON.parse(
      ((await tool.execute(JSON.stringify(args), ctx())) as { text: string })
        .text,
    ) as Record<string, unknown>;
  return { session, tool, call, refs, download, sandbox, generator };
}

describe("multi-target attachment import", () => {
  it("routes by target, converts HEIC for the generator and keeps sandbox defaults", async () => {
    const f = await attachmentFixture(true);
    expect(f.session.targetNames()).toEqual(["sandbox", "image_generator"]);
    expect(
      (f.tool.definition.parameters as { properties: Record<string, unknown> })
        .properties.target,
    ).toMatchObject({ enum: ["sandbox", "image_generator"] });
    const photo = await f.call({
      attachment_ref: f.refs[0],
      target: "image_generator",
    });
    expect(photo).toMatchObject({
      status: "imported",
      target: "image_generator",
      filename: "IMG_0001.jpeg",
      converted: "gateway-jpeg",
    });
    expect(String(photo.sandbox_path)).toMatch(/^\/workspace\/image-gen\//u);
    expect(f.download).toHaveBeenCalledWith("photo", expect.anything(), {
      original: false,
    });
    // Registration metadata names no single target; the call records it.
    expect(f.tool.metadata).toMatchObject({
      targets: [
        { target: "sandbox", server: "sandbox" },
        { target: "image_generator", server: "image" },
      ],
    });
    expect(f.tool.metadata).not.toHaveProperty("pluginId");
    expect(f.generator.transfer).toHaveBeenCalledTimes(1);
    expect(f.sandbox.transfer).not.toHaveBeenCalled();
    const sheet = await f.call({ attachment_ref: f.refs[1] });
    expect(sheet).toMatchObject({ status: "imported", target: "sandbox" });
    expect(f.download).toHaveBeenLastCalledWith("sheet", expect.anything(), {});
  });
  it("falls back to the gateway JPEG when a photo labelled JPEG is HEIC", async () => {
    const f = await attachmentFixture(true);
    for (const target of ["image_generator", "sandbox"]) {
      f.download.mockClear();
      const imported = await f.call({ attachment_ref: f.refs[2], target });
      expect(imported).toMatchObject({
        status: "imported",
        target,
        filename: "IMG_0002.jpeg",
        converted: "gateway-jpeg",
      });
      expect(f.download.mock.calls.map((c) => c[2])).toEqual([
        {},
        { original: false },
      ]);
    }
    // A genuine JPEG keeps the original with a single download.
    f.download.mockClear();
    expect(
      await f.call({ attachment_ref: f.refs[3], target: "image_generator" }),
    ).toMatchObject({ status: "imported", filename: "real.jpeg" });
    expect(f.download).toHaveBeenCalledTimes(1);
    expect(f.download).toHaveBeenLastCalledWith("real", expect.anything(), {});
  });
  it("imports HEIC photos into the sandbox as the gateway JPEG", async () => {
    const f = await attachmentFixture(true);
    expect(
      await f.call({ attachment_ref: f.refs[0], target: "sandbox" }),
    ).toMatchObject({
      status: "imported",
      target: "sandbox",
      filename: "IMG_0001.jpeg",
      converted: "gateway-jpeg",
    });
    expect(f.download).toHaveBeenLastCalledWith("photo", expect.anything(), {
      original: false,
    });
  });
  it("rejects non-images for the generator before downloading", async () => {
    const f = await attachmentFixture(true);
    expect(
      await f.call({ attachment_ref: f.refs[1], target: "image_generator" }),
    ).toMatchObject({ errorCode: "ATTACHMENT_TYPE_UNSUPPORTED_FOR_TARGET" });
    expect(f.download).not.toHaveBeenCalled();
    expect(
      await f.call({ attachment_ref: f.refs[0], target: "elsewhere" }),
    ).toMatchObject({ errorCode: "ATTACHMENT_ARGUMENTS_INVALID" });
  });
  it("defaults generator-only nodes to the generator without a target field", async () => {
    const f = await attachmentFixture(false);
    expect(f.session.targetNames()).toEqual(["image_generator"]);
    expect(
      (f.tool.definition.parameters as { properties: Record<string, unknown> })
        .properties.target,
    ).toBeUndefined();
    expect(await f.call({ attachment_ref: f.refs[0] })).toMatchObject({
      status: "imported",
      target: "image_generator",
    });
  });
  it("keeps sandbox-only guidance byte-identical", () => {
    const sandboxOnly = attachmentGuidanceFor(["sandbox"]);
    expect(
      attachmentGuidanceFor(["sandbox", "image_generator"]).startsWith(
        sandboxOnly,
      ),
    ).toBe(true);
    expect(attachmentGuidanceFor(["image_generator"])).not.toContain(
      "sandbox's existing command tools",
    );
    expect(replyAttachmentGuidance({ sandbox: true, generator: false })).toBe(
      imageReplyGuidance,
    );
    expect(
      replyAttachmentGuidance({ sandbox: false, generator: true }),
    ).not.toContain("bound sandbox");
  });
});

describe("multi-target reply attachments", () => {
  it("exports generator paths through the generator and others through the sandbox", async () => {
    const artifact = {
      id: randomUUID(),
      sha256: "a".repeat(64),
      width: 1,
      height: 1,
      size: 1,
    } as ImageArtifact;
    const save = vi.fn().mockResolvedValue(artifact);
    const store = {
      save,
      discard: vi.fn(),
      ref: () => null,
    } as unknown as GeneratedImageStore;
    const sandbox = {
      check: vi.fn(),
      export: vi.fn().mockResolvedValue(Buffer.from("s")),
      workspacePrefix: "/workspace/",
    };
    const generator = {
      check: vi.fn(),
      export: vi.fn().mockResolvedValue(Buffer.from("g")),
      workspacePrefix: "/workspace/image-gen/",
    };
    const sandboxPlugin = randomUUID();
    const generatorPlugin = randomUUID();
    const plugins = {
      imageExportChannel: () => sandbox,
      generatorChannels: () => ({
        workspacePrefix: "/workspace/image-gen/",
        mimeTypes: [],
        attachment: {},
        export: generator,
      }),
    } as unknown as PluginSession;
    const session = new GeneratedImageSession(
      {
        config: {
          enabled: true,
          pluginId: sandboxPlugin,
          server: "sandbox",
          allowedTypes: ["png", "pdf"],
        },
        generator: { pluginId: generatorPlugin, server: "image" },
        executionId: randomUUID(),
        nodeId: "ai",
        chatId: "fictional-chat",
      },
      plugins,
      store,
    );
    const registry = new AgentToolRegistry();
    session.register(registry);
    const tool = registry.get("prepare_chat_attachment")!;
    expect(tool.definition.description).toContain(
      "/workspace/image-gen/ (image generator) allow: png",
    );
    await tool.execute(
      JSON.stringify({ path: "/workspace/image-gen/out/a.png" }),
      ctx(),
    );
    expect(generator.export).toHaveBeenCalledWith(
      "/workspace/image-gen/out/a.png",
      expect.anything(),
      false,
    );
    expect(save.mock.calls[0]![0]).toMatchObject({
      pluginId: generatorPlugin,
      server: "image",
    });
    expect(save.mock.calls[0]![3]).toMatchObject({ allowedTypes: ["png"] });
    await tool.execute(
      JSON.stringify({ path: "/workspace/report.pdf" }),
      ctx(),
    );
    expect(sandbox.export).toHaveBeenCalledWith(
      "/workspace/report.pdf",
      expect.anything(),
      true,
    );
    expect(save.mock.calls[1]![0]).toMatchObject({ pluginId: sandboxPlugin });
    // A PDF under the generator namespace is not allowed there.
    const denied = JSON.parse(
      (await tool.execute(
        JSON.stringify({ path: "/workspace/image-gen/out/a.pdf" }),
        ctx(),
      )) as string,
    ) as { status: string };
    expect(denied.status).toBe("failed");
  });
});

describe("imageGeneration workflow configuration", () => {
  const sandboxId = randomUUID();
  const generatorId = randomUUID();
  const definition = (config: Record<string, unknown>, withReply = true) => ({
    schemaVersion: "1",
    name: "fictional",
    startNodeId: "ai",
    nodes: [
      {
        id: "ai",
        type: "ai-chat",
        version: 1,
        config: {
          providerRouteId: randomUUID(),
          systemPrompt: "fictional",
          promptTemplate: "draw",
          pluginIds: [sandboxId, generatorId],
          ...config,
        },
        onSuccess: "reply",
      },
      {
        id: "reply",
        type: "reply",
        version: 1,
        config: { text: "fictional" },
        onSuccess: "done",
        inputs: {
          text: { kind: "output", blockId: "ai", port: "text" },
          ...(withReply
            ? {
                generatedImage: {
                  kind: "output",
                  blockId: "ai",
                  port: "generatedImage",
                },
              }
            : {}),
        },
      },
      {
        id: "done",
        type: "end",
        version: 1,
        config: { result: "succeeded" },
      },
    ],
  });
  it("accepts a generator alongside the sandbox and as the only attachment source", () => {
    expect(() =>
      parseWorkflowDefinition(
        definition({
          imageReply: { enabled: true, pluginId: sandboxId, server: "sandbox" },
          imageGeneration: {
            enabled: true,
            pluginId: generatorId,
            server: "image",
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      parseWorkflowDefinition(
        definition({
          imageGeneration: {
            enabled: true,
            pluginId: generatorId,
            server: "image",
          },
        }),
      ),
    ).not.toThrow();
  });
  it("rejects reusing the sandbox target, unbound plugins and missing reply wiring", () => {
    expect(() =>
      parseWorkflowDefinition(
        definition({
          imageReply: { enabled: true, pluginId: sandboxId, server: "sandbox" },
          imageGeneration: {
            enabled: true,
            pluginId: sandboxId,
            server: "sandbox",
          },
        }),
      ),
    ).toThrow(/imageGeneration|distinct from the sandbox/u);
    expect(() =>
      parseWorkflowDefinition(
        definition({
          pluginIds: [sandboxId],
          imageGeneration: {
            enabled: true,
            pluginId: generatorId,
            server: "image",
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseWorkflowDefinition(
        definition(
          {
            imageGeneration: {
              enabled: true,
              pluginId: generatorId,
              server: "image",
            },
          },
          false,
        ),
      ),
    ).toThrow("Image reply requires exactly one connected Reply node.");
  });
});
