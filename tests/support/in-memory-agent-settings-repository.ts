import type { AgentSettingsUpdate } from "../../modules/ai/agent-settings-types.js";
import type {
  AgentSettingsRecord,
  AgentSettingsRepository,
} from "../../modules/ai/agent-settings-repository.js";

export class InMemoryAgentSettingsRepository implements AgentSettingsRepository {
  private stored: AgentSettingsRecord | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  find(): Promise<AgentSettingsRecord | null> {
    return Promise.resolve(this.stored === null ? null : { ...this.stored });
  }

  save(
    input: AgentSettingsUpdate,
  ): Promise<
    { status: "ok"; value: AgentSettingsRecord } | { status: "conflict" }
  > {
    if (
      (this.stored === null && input.expectedVersion !== 0) ||
      (this.stored !== null && this.stored.version !== input.expectedVersion)
    ) {
      return Promise.resolve({ status: "conflict" });
    }
    const value: AgentSettingsRecord = {
      maxToolCalls: input.maxToolCalls,
      maxToolOutputCharacters: input.maxToolOutputCharacters,
      maxToolDurationMs: input.maxToolDurationMs,
      version: (this.stored?.version ?? 0) + 1,
      updatedAt: this.now().toISOString(),
    };
    this.stored = value;
    return Promise.resolve({ status: "ok", value: { ...value } });
  }

  isReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
