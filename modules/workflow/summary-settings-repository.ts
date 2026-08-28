import type {
  SummaryRuntimeSettings,
  SummarySettingsUpdate,
} from "./summary-settings-types.js";

export interface SummarySettingsRecord extends SummaryRuntimeSettings {
  version: number;
  policyVersion: number;
  updatedAt: string;
}

export interface SummarySettingsRepository {
  find(): Promise<SummarySettingsRecord | null>;
  save(
    input: SummarySettingsUpdate,
  ): Promise<
    { status: "ok"; value: SummarySettingsRecord } | { status: "conflict" }
  >;
}
