import type {
  AgentSettingsUpdate,
  AgentSettingsView,
} from "./agent-settings-types.js";
export type AgentSettingsRecord = Omit<AgentSettingsView, "source">;
export interface AgentSettingsRepository {
  find(): Promise<AgentSettingsRecord | null>;
  save(
    input: AgentSettingsUpdate,
  ): Promise<
    { status: "ok"; value: AgentSettingsRecord } | { status: "conflict" }
  >;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
