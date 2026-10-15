import { readFileSync } from "node:fs";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  exportWorkflowManifest,
  importWorkflowManifest,
  WorkflowManifestPreviewSigner,
  type WorkflowBindingCatalog,
} from "../modules/workflow/workflow-manifest.js";
import type { WorkflowDefinition } from "../modules/workflow/workflow-definition.js";
import { workflowDataEdges } from "../apps/web/src/utils/workflow-data-edges.js";
import {
  parseWorkflowDefinition,
  workflowDefinitionSchema,
} from "../modules/workflow/workflow-definition.js";
import { workflowGraphSchema } from "../modules/workflow/workflow-graph.js";

const routeId = "11111111-1111-4111-8111-111111111111";
const chatId = "iMessage;-;fictional-chat";
const catalog: WorkflowBindingCatalog = {
  aiRoutes: [
    {
      id: routeId,
      name: "Fictional AI route",
      capabilities: ["text", "function-calling", "image-input"],
    },
  ],
  chats: [{ id: chatId, name: "Fictional group", capabilities: [] }],
};

const definition: WorkflowDefinition = {
  schemaVersion: "1",
  name: "Fictional assistant",
  startNodeId: "message-trigger",
  maxSteps: 16,
  nodes: [
    {
      id: "message-trigger",
      type: "message-trigger",
      version: 1,
      config: {
        provider: "bluebubbles",
        chatIds: [chatId],
        senderIds: [],
        contentTypes: ["text"],
        includeFromMe: false,
        enabled: true,
        text: null,
      },
      onSuccess: "ai",
    },
    {
      id: "ai",
      type: "ai-chat",
      version: 1,
      config: {
        providerRouteId: routeId,
        systemPrompt: "Be concise.",
        promptTemplate: "{{message.text}}",
        includeLoadedContext: true,
        maxOutputTokens: 256,
        maxOutputCharacters: 1_000,
        temperature: null,
        webSearch: "auto",
        webSearchSources: "hidden",
        outputFormat: "text",
        outputVariable: "aiReply",
      },
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

describe("workflow manifest", () => {
  it("keeps the checked-in workflow JSON Schema synchronized with runtime schemas", () => {
    const generated = z.toJSONSchema(
      z.union([workflowDefinitionSchema, workflowGraphSchema]),
      { target: "draft-2020-12", unrepresentable: "any" },
    );
    generated.$id = "https://bubblepilot.local/contracts/workflow.schema.json";
    generated.title = "BubblePilot Workflow Definition";
    const checkedIn = JSON.parse(
      readFileSync("contracts/workflow.schema.json", "utf8"),
    ) as unknown;
    expect(checkedIn).toEqual(generated);
  });

  it("exports a portable manifest without instance identifiers and imports it losslessly", () => {
    const manifest = exportWorkflowManifest({
      definition,
      mode: "portable",
      catalog,
    });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(routeId);
    expect(serialized).not.toContain(chatId);
    expect(
      manifest.bindings.aiRoutes["ai-route-1"]?.requiredCapabilities,
    ).toEqual(["text", "function-calling"]);

    const imported = importWorkflowManifest({ manifest, catalog });
    expect(imported.issues).toEqual([]);
    expect(imported.definition).toEqual({
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.type === "message-trigger" || node.type === "ai-chat"
          ? { ...node, config: { ...node.config } }
          : node,
      ),
    });
  });

  it.each(["portable", "instance-bound"] as const)(
    "preserves all data wires after JSON editing and %s reimport",
    (mode) => {
      const original = parseWorkflowDefinition({
        ...definition,
        nodes: [
          { ...definition.nodes[0], onSuccess: "load-context" },
          {
            id: "load-context",
            type: "load-context",
            version: 1,
            position: { x: 300, y: 100 },
            config: {},
            onSuccess: "ai",
          },
          {
            ...definition.nodes[1],
            onSuccess: "reply",
            inputs: {
              messages: {
                kind: "output",
                blockId: "load-context",
                port: "messages",
              },
              prompt: { kind: "path", path: "context.event.message.text" },
            },
            config: { ...definition.nodes[1]!.config, allowMemes: true },
          },
          {
            id: "reply",
            type: "reply",
            version: 1,
            config: { text: "{{variables.aiReply}}" },
            inputs: {
              text: { kind: "output", blockId: "ai", port: "text" },
              meme: { kind: "output", blockId: "ai", port: "meme" },
            },
            onSuccess: "done",
          },
          definition.nodes[2],
        ],
      });
      const before = structuredClone(original);
      const manifest = exportWorkflowManifest({
        definition: original,
        mode,
        catalog,
      });
      // Simulate editing the downloaded file, without touching node references.
      manifest.metadata.name = "Renamed fictional assistant";
      manifest.spec.nodes.find(
        (node) => node.id === "ai",
      )!.config.systemPrompt = "New fictional prompt.";
      const imported = importWorkflowManifest({
        manifest: JSON.parse(JSON.stringify(manifest)),
        catalog,
      });
      expect(imported.issues).toEqual([]);
      const restored = parseWorkflowDefinition(imported.definition);
      expect(restored.name).toBe(manifest.metadata.name);
      for (const node of restored.nodes) {
        const previous = original.nodes.find((item) => item.id === node.id)!;
        expect(node.inputs).toEqual(previous.inputs);
        expect(node.position).toEqual(previous.position);
      }
      const wires = workflowDataEdges(restored.nodes);
      expect(wires).toEqual(workflowDataEdges(original.nodes));
      expect(
        wires.map((wire) => [wire.sourceHandle, wire.targetHandle]),
      ).toEqual([
        ["output:messages", "input:messages"],
        ["output:text", "input:text"],
        ["output:meme", "input:meme"],
      ]);
      expect(original).toEqual(before);
      const expected = structuredClone(original);
      expected.name = manifest.metadata.name;
      const ai = expected.nodes.find((node) => node.type === "ai-chat")!;
      if (ai.type === "ai-chat")
        ai.config.systemPrompt = "New fictional prompt.";
      expect(restored).toEqual(expected);
    },
  );

  it("preserves explicit identifiers only for instance-bound exports", () => {
    const manifest = exportWorkflowManifest({
      definition,
      mode: "instance-bound",
      catalog,
    });
    expect(manifest.bindings.aiRoutes["ai-route-1"]?.instanceId).toBe(routeId);
    expect(manifest.bindings.chats["chat-1"]?.instanceId).toBe(chatId);
  });

  it("reports ambiguous bindings with JSON Pointer locations", () => {
    const manifest = exportWorkflowManifest({
      definition,
      mode: "portable",
      catalog,
    });
    manifest.bindings.aiRoutes["ai-route-1"]!.name = "Unknown route";
    const imported = importWorkflowManifest({
      manifest,
      catalog: {
        ...catalog,
        aiRoutes: [
          ...catalog.aiRoutes,
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Other compatible route",
            capabilities: ["text", "function-calling"],
          },
        ],
      },
    });
    expect(imported.issues).toContainEqual(
      expect.objectContaining({
        path: "/bindings/aiRoutes/ai-route-1",
        code: "BINDING_AMBIGUOUS",
      }),
    );
  });

  it("rejects expired, tampered, and catalog-stale preview tokens", () => {
    const manifest = exportWorkflowManifest({
      definition,
      mode: "portable",
      catalog,
    });
    const signer = new WorkflowManifestPreviewSigner(
      "fictional-signing-secret",
      1_000,
    );
    const preview = signer.issue(manifest, catalog, 10_000);
    expect(signer.verify(preview.token, manifest, catalog, 10_500)).toBe(
      "valid",
    );
    expect(signer.verify(`${preview.token}x`, manifest, catalog, 10_500)).toBe(
      "invalid",
    );
    expect(
      signer.verify(preview.token, manifest, { ...catalog, chats: [] }, 10_500),
    ).toBe("invalid");
    expect(signer.verify(preview.token, manifest, catalog, 11_001)).toBe(
      "expired",
    );
  });
});
