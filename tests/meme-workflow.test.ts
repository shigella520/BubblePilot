import { it, expect } from "vitest";
import { parseWorkflowDefinition } from "../modules/workflow/workflow-definition.js";
function definition() {
  return {
    schemaVersion: "1",
    name: "虚构表情工作流",
    startNodeId: "ai",
    nodes: [
      {
        id: "ai",
        type: "ai-chat",
        version: 1,
        config: {
          providerRouteId: "11111111-1111-4111-8111-111111111111",
          promptTemplate: "虚构测试",
          allowMemes: true,
          outputFormat: "text",
        },
        onSuccess: "reply",
      },
      {
        id: "reply",
        type: "reply",
        version: 1,
        config: { text: "fallback" },
        inputs: {
          text: { kind: "output", blockId: "ai", port: "text" },
          meme: { kind: "output", blockId: "ai", port: "meme" },
        },
        onSuccess: "done",
      },
      { id: "done", type: "end", version: 1, config: { result: "succeeded" } },
    ],
  };
}
it("accepts typed meme and text outputs from the same AI node", () => {
  expect(() => parseWorkflowDefinition(definition())).not.toThrow();
});
it("rejects literal meme IDs, JSON AI mode and native reply combinations", () => {
  const native = definition();
  Object.assign(native.nodes[1]!.config, { replyToSourceMessage: true });
  expect(() => parseWorkflowDefinition(native)).toThrow();
  const json = definition();
  json.nodes[0]!.config.outputFormat = "json";
  expect(() => parseWorkflowDefinition(json)).toThrow();
  const literal = definition();
  Object.assign(literal.nodes[1]!.inputs!, {
    meme: { kind: "literal", value: { id: "guessed" } },
  });
  expect(() => parseWorkflowDefinition(literal)).toThrow();
  const disabled = definition();
  disabled.nodes[0]!.config.allowMemes = false;
  expect(() => parseWorkflowDefinition(disabled)).toThrow();
});
