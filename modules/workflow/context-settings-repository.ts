import type {
  ContextRuntimeSettings,
  ContextSettingsUpdate,
} from "./context-settings-types.js";

export interface ContextSettingsRecord extends ContextRuntimeSettings {
  version: number;
  updatedAt: string;
}

export interface ContextSettingsRepository {
  close?(): Promise<void>;
  isReady(): Promise<boolean>;
  find(): Promise<ContextSettingsRecord | null>;
  save(
    input: ContextSettingsUpdate,
  ): Promise<
    { status: "ok"; value: ContextSettingsRecord } | { status: "conflict" }
  >;
}
