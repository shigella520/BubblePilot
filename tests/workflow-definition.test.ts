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
