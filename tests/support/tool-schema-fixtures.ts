import { importChatAttachmentDefinition } from "../../modules/attachments/attachment-session.js";
import { expect } from "vitest";
import { AgentToolRegistry } from "../../modules/ai/agent-tool-registry.js";
import { webSearchDefinition } from "../../modules/ai/agent-runner.js";
import { chatImageToolDefinition } from "../../modules/ai/chat-image-session.js";
import { capabilityProbeTool } from "../../modules/ai/ai-management-service.js";
import { memoryTools } from "../../modules/memory/memory-service.js";
import { MemeToolSession } from "../../modules/memes/meme-tools.js";
import type { MemeRepository } from "../../modules/memes/meme-types.js";
import { taskToolDefinitions } from "../../modules/scheduled-tasks/task-tool-definitions.js";
import { mcpModelDefinition } from "../../modules/plugins/plugin-schema.js";
import { PluginSession } from "../../modules/plugins/plugin-session.js";
import type { PluginService } from "../../modules/plugins/plugin-service.js";
import type { InstalledPlugin } from "../../modules/plugins/plugin-types.js";

export function allToolDefinitions() {
  const registry = new AgentToolRegistry();
  new MemeToolSession({} as MemeRepository).register(registry);
  const plugin: InstalledPlugin = {
    id: "fictional-plugin",
    name: "Fictional",
    enabled: true,
    version: 1,
    revision: "r1",
    package: {
      name: "Fictional",
      version: "1.0.0",
      description: "Fictional",
      format: "portable-1",
      skills: [
        {
          id: "skill",
          name: "Skill",
          description: "Fictional",
          file: "SKILL.md",
          references: [],
          contentHash: "fictional",
        },
      ],
      servers: [],
      files: {},
      hash: "r1",
    },
    config: {
      tools: [
        {
          server: "mock",
          hash: "fixture",
          definition: {
            name: "tool",
            description: "Fictional",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        },
      ],
      disabledSkills: [],
      disabledTools: [],
      connections: {
        mock: {
          url: "https://example.test/mcp",
          allowPrivate: false,
          auth: "none",
          header: "X-Key",
        },
      },
    },
  };
  new PluginSession({} as PluginService, [plugin]).register(registry);
  return [
    ...memoryTools,
    importChatAttachmentDefinition,
    ...registry.definitions().filter((tool) => !tool.name.startsWith("ext_")),
    webSearchDefinition,
    chatImageToolDefinition,
    capabilityProbeTool,
    ...taskToolDefinitions("UTC"),
    mcpModelDefinition({
      name: "fictional_mcp",
      description: "Fictional MCP tool",
      parameters: {
        type: "object",
        properties: { optional: { type: "string" } },
        additionalProperties: false,
      },
    }),
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
