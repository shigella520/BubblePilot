import { describe, expect, it, vi } from "vitest";
import { pluginCatalogueUsage } from "../modules/plugins/plugin-catalogue.js";
import { PluginService } from "../modules/plugins/plugin-service.js";
import { PluginStorage } from "../modules/plugins/plugin-storage.js";
import { PluginSession } from "../modules/plugins/plugin-session.js";
import { AgentToolRegistry } from "../modules/ai/agent-tool-registry.js";
import {
  pluginRuntimeSettingsSchema,
  type InstalledPlugin,
} from "../modules/plugins/plugin-types.js";
const plugin: InstalledPlugin = {
  id: "fictional-id",
  name: "fictional",
  enabled: true,
  version: 1,
  revision: "fixture",
  package: {
    name: "fictional",
    version: "1",
    description: "Fixture",
    format: "portable-1",
    hash: "fixture",
    files: {},
    servers: [],
    skills: [
      {
        id: "guide",
        name: "guide",
        description: "Public lookup",
        file: "SKILL.md",
        references: [],
        contentHash: "fixture",
      },
    ],
  },
  config: {
    connections: {},
    disabledSkills: [],
    disabledTools: [],
    tools: [
      {
        server: "public",
        definition: {
          name: "lookup",
          description: "Find public pages",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
        outputSchema: { type: "object", description: "x".repeat(30000) },
        hash: "fixture",
      },
    ],
  },
};
describe("plugin catalogue resource budget", () => {
  it("counts the Agent definitions and catalogue, excluding storage-only fields", () => {
    const service = {} as PluginService;
    const usage = pluginCatalogueUsage(service, [plugin]);
    const session = new PluginSession(service, [plugin]);
    const registry = new AgentToolRegistry();
    session.register(registry);
    expect(usage.characters).toBe(
      JSON.stringify(registry.definitions()).length +
        JSON.stringify(session.catalogue()).length,
    );
    expect(usage.characters).toBeLessThan(24000);
    const changed = structuredClone(plugin);
    changed.config.tools[0]!.hash = "x".repeat(50000);
    delete changed.config.tools[0]!.outputSchema;
    expect(pluginCatalogueUsage(service, [changed]).characters).toBe(
      usage.characters,
    );
    expect(usage.sharedCharacters + usage.plugins[0]!.characters).toBe(
      usage.characters,
    );
  });
  it("excludes disabled capabilities and counts shared Skill tools once", () => {
    const disabled = structuredClone(plugin);
    disabled.config.disabledTools = ["public/lookup"];
    disabled.config.disabledSkills = ["guide"];
    expect(pluginCatalogueUsage({} as PluginService, [disabled])).toMatchObject(
      { characters: 4, toolCount: 0 },
    );
    expect(
      pluginCatalogueUsage({} as PluginService, [
        plugin,
        { ...plugin, id: "second" },
      ]).toolCount,
    ).toBe(4);
  });
  it("enforces the configured boundary, deduplicates plugin IDs and reports usage", async () => {
    const service = new PluginService(
      "postgresql://unused.example.test/test",
      new PluginStorage("/tmp/fictional-plugin-unused"),
      "fictional-key",
    );
    try {
      vi.spyOn(service, "get").mockResolvedValue(plugin);
      const size = pluginCatalogueUsage(service, [plugin]).characters;
      const settings = vi.spyOn(service, "runtimeSettings").mockResolvedValue({
        catalogueCharacters: size,
        version: 1,
        updatedAt: "fixture",
      });
      await expect(
        service.assertAvailable([plugin.id, plugin.id]),
      ).resolves.toBeUndefined();
      settings.mockResolvedValue({
        catalogueCharacters: size - 1,
        version: 2,
        updatedAt: "fixture",
      });
      await expect(service.assertAvailable([plugin.id])).rejects.toMatchObject({
        code: "PLUGIN_CATALOGUE_TOO_LARGE",
        message: expect.stringContaining(String(size)) as string,
      });
      settings.mockClear();
      await service.assertAvailable([]);
      expect(settings).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });
  it("bounds configuration without coercing or accepting fractional sizes", () => {
    for (const value of [7999, 256001, 64000.5, "64000"])
      expect(
        pluginRuntimeSettingsSchema.safeParse({
          catalogueCharacters: value,
          expectedVersion: 1,
        }).success,
      ).toBe(false);
    expect(
      pluginRuntimeSettingsSchema.parse({
        catalogueCharacters: 64000,
        expectedVersion: 1,
      }).catalogueCharacters,
    ).toBe(64000);
  });
});
