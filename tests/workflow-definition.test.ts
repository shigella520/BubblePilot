import { describe, expect, it } from "vitest";

import { parseWorkflowDefinition } from "../modules/workflow/workflow-definition.js";

function definition(webSearchSources?: "full" | "compact" | "hidden") {
  return {
    schemaVersion: "1",
    name: "search source display",
    startNodeId: "ask-ai",
    nodes: [
      {
        id: "ask-ai",
        type: "ai-chat",
        version: 1,
        config: {
          providerRouteId: "11111111-1111-4111-8111-111111111111",
          promptTemplate: "Answer the current message.",
          webSearch: "auto",
          ...(webSearchSources === undefined ? {} : { webSearchSources }),
        },
        onSuccess: "done",
      },
      {
        id: "done",
        type: "end",
        version: 1,
        config: {},
      },
    ],
  };
}

describe("workflow search source display", () => {
  it("preserves the existing full-source behavior by default", () => {
    const parsed = parseWorkflowDefinition(definition());
    const node = parsed.nodes.find((item) => item.type === "ai-chat");
    expect(node?.config.webSearchSources).toBe("full");
  });

  it("accepts hidden sources as versioned workflow data", () => {
    const parsed = parseWorkflowDefinition(definition("hidden"));
    const node = parsed.nodes.find((item) => item.type === "ai-chat");
    expect(node?.config.webSearchSources).toBe("hidden");
  });
});

describe("render-text workflow node", () => {
  it("accepts known Context paths and upstream output references", () => {
    const parsed = parseWorkflowDefinition({
      schemaVersion: "1",
      name: "render text",
      startNodeId: "first",
      nodes: [
        {
          id: "first",
          type: "render-text",
          version: 1,
          config: { template: "{{context.event.message.text}}" },
          onSuccess: "second",
        },
        {
          id: "second",
          type: "render-text",
          version: 1,
          config: {
            template: "Result: {{context.outputs.first.text}}",
          },
          onSuccess: "done",
        },
        {
          id: "done",
          type: "end",
          version: 1,
          config: {},
        },
      ],
    });

    expect(parsed.nodes.map((node) => node.type)).toContain("render-text");
  });

  it("rejects unsupported Context paths", () => {
    expect(() =>
      parseWorkflowDefinition({
        schemaVersion: "1",
        name: "invalid render text",
        startNodeId: "render",
        nodes: [
          {
            id: "render",
            type: "render-text",
            version: 1,
            config: { template: "{{context.secrets.apiKey}}" },
            onSuccess: "done",
          },
          {
            id: "done",
            type: "end",
            version: 1,
            config: {},
          },
        ],
      }),
    ).toThrow(/unsupported Context path/);
  });
});
