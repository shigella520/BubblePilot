import { describe, expect, it } from "vitest";
import { validateWorkflowGraph } from "../modules/workflow/workflow-graph.js";

const base = {
  schemaVersion: "1" as const,
  name: "chat assistant",
  startNodeId: "load-context",
  maxSteps: 16,
  maxExecutionMs: 120000,
  nodes: [
    { id: "load-context", type: "load-context", version: 1, position: { x: 0, y: 0 }, config: { messageLimit: 10, characterLimit: 6000, includeFromMe: true }, inputs: {} },
    { id: "ai", type: "ai-chat", version: 1, position: { x: 240, y: 0 }, config: {}, inputs: { messages: { kind: "output", blockId: "load-context", port: "messages" }, prompt: { kind: "path", path: "context.event.message.text" } } },
    { id: "done", type: "end", version: 1, position: { x: 480, y: 0 }, config: {}, inputs: {} },
  ],
  edges: [
    { id: "load-ai", source: "load-context", sourcePort: "messages", target: "ai", targetPort: "messages", kind: "data" as const },
    { id: "load-success", source: "load-context", sourcePort: "success", target: "ai", targetPort: "success", kind: "success" as const },
    { id: "ai-success", source: "ai", sourcePort: "success", target: "done", targetPort: "success", kind: "success" as const },
  ],
};

describe("workflow graph validation", () => {
  it("accepts compatible data edges and context paths", () => {
    expect(validateWorkflowGraph(base).schemaVersion).toBe("1");
  });

  it("rejects incompatible data edges", () => {
    expect(() => validateWorkflowGraph({ ...base, edges: [{ ...base.edges[0], sourcePort: "count" }] })).toThrow(/incompatible|unknown port/);
  });

  it("rejects unreachable nodes", () => {
    expect(() => validateWorkflowGraph({ ...base, nodes: [...base.nodes, { id: "orphan", type: "end", version: 1, position: { x: 0, y: 100 }, config: {}, inputs: {} }] })).toThrow(/unreachable/);
  });
});
