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
import { workflowDefinitionSchema } from "../modules/workflow/workflow-definition.js";
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
