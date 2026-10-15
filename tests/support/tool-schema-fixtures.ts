import { expect } from "vitest";
import { AgentToolRegistry } from "../../modules/ai/agent-tool-registry.js";
import { webSearchDefinition } from "../../modules/ai/agent-runner.js";
import { chatImageToolDefinition } from "../../modules/ai/chat-image-session.js";
import { capabilityProbeTool } from "../../modules/ai/ai-management-service.js";
import { memoryTools } from "../../modules/memory/memory-service.js";
import { MemeToolSession } from "../../modules/memes/meme-tools.js";
import type { MemeRepository } from "../../modules/memes/meme-types.js";

export function allToolDefinitions() {
  const registry = new AgentToolRegistry();
  new MemeToolSession({} as MemeRepository).register(registry);
  return [
    ...memoryTools,
    ...registry.definitions(),
    webSearchDefinition,
    chatImageToolDefinition,
    capabilityProbeTool,
  ];
}

/** Independent mock upstream check for the strict object contract. */
export function assertStrictSchema(value: unknown): void {
  expect(value).toBeTypeOf("object");
  const s = value as Record<string, unknown>;
  expect(s).not.toHaveProperty("default");
  expect(s).not.toHaveProperty("$schema");
  if (
    s.type === "object" ||
    (Array.isArray(s.type) && s.type.includes("object"))
  ) {
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(Object.keys(s.properties as object));
    for (const child of Object.values(s.properties as object))
      assertStrictSchema(child);
  }
  if (s.items) assertStrictSchema(s.items);
  if (Array.isArray(s.anyOf)) s.anyOf.forEach(assertStrictSchema);
}
