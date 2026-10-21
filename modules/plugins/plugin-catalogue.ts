import { AgentToolRegistry } from "../ai/agent-tool-registry.js";
import { PluginSession } from "./plugin-session.js";
import type { PluginService } from "./plugin-service.js";
import type { InstalledPlugin } from "./plugin-types.js";

/** Count the same enabled definitions and skill catalogue used by the Agent. */
export function pluginCatalogueUsage(
  service: PluginService,
  plugins: InstalledPlugin[],
) {
  const session = new PluginSession(service, plugins);
  const registry = new AgentToolRegistry();
  session.register(registry);
  const definitions = registry.definitions();
  const catalogue = session.catalogue();
  const entries = plugins.map((plugin) => {
    const ownSession = new PluginSession(service, [plugin]);
    const ownRegistry = new AgentToolRegistry();
    ownSession.register(ownRegistry);
    const tools = ownRegistry
      .definitions()
      .filter((tool) => tool.name.startsWith("ext_"));
    return {
      id: plugin.id,
      name: plugin.name,
      toolCount: tools.length,
      characters:
        tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0) +
        ownSession
          .catalogue()
          .reduce((sum, skill) => sum + JSON.stringify(skill).length, 0),
    };
  });
  const characters =
    JSON.stringify(definitions).length + JSON.stringify(catalogue).length;
  return {
    characters,
    toolCount: definitions.length,
    plugins: entries,
    sharedCharacters:
      characters - entries.reduce((sum, entry) => sum + entry.characters, 0),
  };
}
