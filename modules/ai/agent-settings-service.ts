import type { AgentSettingsRepository } from "./agent-settings-repository.js";
import {
  agentSettingsUpdateSchema,
  defaultAgentSettings,
  type AgentSettingsUpdate,
  type AgentSettingsView,
} from "./agent-settings-types.js";
export class AgentSettingsService {
  constructor(readonly repository: AgentSettingsRepository) {}
  async view(): Promise<AgentSettingsView> {
    const stored = await this.repository.find();
    return stored
      ? { ...stored, source: "database" }
      : {
          ...defaultAgentSettings,
          source: "defaults",
          version: 0,
          updatedAt: null,
        };
  }
  async update(input: AgentSettingsUpdate) {
    const result = await this.repository.save(
      agentSettingsUpdateSchema.parse(input),
    );
    return result.status === "conflict"
      ? result
      : {
          status: "ok" as const,
          value: { ...result.value, source: "database" as const },
        };
  }
}
