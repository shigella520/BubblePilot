import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { GeneratedImageSession } from "../modules/generated-images/image-session.js";
import {
  GeneratedImageError,
  imageReplySchema,
} from "../modules/generated-images/image-policy.js";
import {
  validateGeneratedPng,
  type GeneratedImageStore,
  type ImageArtifact,
} from "../modules/generated-images/image-store.js";
import type { PluginSession } from "../modules/plugins/plugin-session.js";
import {
  AgentToolRegistry,
  type MultimodalToolResult,
} from "../modules/ai/agent-tool-registry.js";
import type { AgentToolContext } from "../modules/ai/agent-budget.js";
import { imageExportTargets } from "../modules/plugins/plugin-image-exports.js";
import { parseWorkflowDefinition } from "../modules/workflow/workflow-definition.js";
describe("generated image reply boundaries", () => {
  it("decodes actual static PNG, rejects disguised images, oversized dimensions and truncation", async () => {
    const png = await sharp({
      create: { width: 40, height: 20, channels: 4, background: "transparent" },
    })
      .png()
      .toBuffer();
    expect(await validateGeneratedPng(png)).toMatchObject({
      width: 40,
      height: 20,
      size: png.length,
    });
    await expect(validateGeneratedPng(png.subarray(0, 40))).rejects.toThrow(
      "IMAGE_INVALID",
    );
    await expect(
      validateGeneratedPng(await sharp(png).jpeg().toBuffer()),
    ).rejects.toThrow("IMAGE_INVALID");
    await expect(
      validateGeneratedPng(Buffer.alloc(8 * 1024 * 1024 + 1)),
    ).rejects.toThrow("IMAGE_TOO_LARGE");
    const wide = await sharp({
      create: { width: 8193, height: 1, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    await expect(validateGeneratedPng(wide)).rejects.toThrow(
      "IMAGE_PIXELS_EXCEEDED",
    );
  });
  it("selects only after result commit, clears old drafts on failure, and cancels uncommitted results", async () => {
    const input = {
      config: { enabled: true, pluginId: randomUUID(), server: "sandbox" },
      executionId: randomUUID(),
      nodeId: "ai",
      chatId: "fictional-chat",
    };
    const artifact = {
      id: randomUUID(),
      execution_id: input.executionId,
      sha256: "a".repeat(64),
      width: 120,
      height: 80,
      size: 1200,
    } as ImageArtifact;
    const channel = {
      check: vi.fn().mockResolvedValue(undefined),
      export: vi.fn().mockResolvedValue(Buffer.from("mock-transfer")),
    };
    const plugins = {
      imageExportChannel: () => channel,
    } as unknown as PluginSession;
    const discard = vi.fn().mockResolvedValue(undefined);
    const store = {
      save: vi.fn().mockResolvedValue(artifact),
      ref: (row: ImageArtifact) => ({
        id: row.id,
        executionId: row.execution_id,
        sha256: row.sha256,
      }),
      discard,
    } as unknown as GeneratedImageStore;
    const session = new GeneratedImageSession(input, plugins, store),
      registry = new AgentToolRegistry();
    session.register(registry);
    const ctx = {
      signal: new AbortController().signal,
      deadline: Date.now() + 30_000,
      maxOutputCharacters: 4000,
    } as AgentToolContext;
    const call = () =>
      registry
        .get("prepare_chat_image")!
        .execute(JSON.stringify({ path: "/workspace/chart.png" }), ctx);
    const first = (await call()) as MultimodalToolResult;
    expect(session.selection()).toBeNull();
    await first.validateCommit?.();
    first.commitResult?.();
    expect(session.selection()?.id).toBe(artifact.id);
    channel.export.mockRejectedValueOnce(
      new GeneratedImageError("IMAGE_NOT_FOUND"),
    );
    expect(await call()).toContain("IMAGE_NOT_FOUND");
    expect(session.selection()).toBeNull();
    const pending = (await call()) as MultimodalToolResult;
    await session.close(false);
    await expect(pending.validateCommit?.()).rejects.toThrow();
    expect(discard).toHaveBeenCalledWith(session.runId, undefined);
  });
  it("requires explicit plugin binding and one typed output consumer", () => {
    expect(
      imageReplySchema.safeParse({ enabled: true, pluginId: "", server: "" })
        .success,
    ).toBe(false);
    expect(imageExportTargets([])).toEqual([]);
    const pluginId = randomUUID();
    const raw = {
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
            pluginIds: [pluginId],
            imageReply: { enabled: true, pluginId, server: "sandbox" },
          },
          onSuccess: "reply",
        },
        {
          id: "reply",
          type: "reply",
          version: 1,
          config: { text: "fictional" },
          inputs: { text: { kind: "output", blockId: "ai", port: "text" } },
          onSuccess: "done",
        },
        {
          id: "done",
          type: "end",
          version: 1,
          config: { result: "succeeded" },
        },
      ],
    };
    expect(() => parseWorkflowDefinition(raw)).toThrow(/exactly one/);
    const wired = structuredClone(raw);
    Object.assign(wired.nodes[1]!.inputs!, {
      generatedImage: { kind: "output", blockId: "ai", port: "generatedImage" },
    });
    expect(() => parseWorkflowDefinition(wired)).not.toThrow();
  });
});
