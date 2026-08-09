import type {
  ImageInputRuntimeSettings,
  ImageInputSettingsUpdate,
} from "./image-input-settings-types.js";

export interface ImageInputSettingsRecord extends ImageInputRuntimeSettings {
  version: number;
  updatedAt: string;
}

export interface ImageInputSettingsRepository {
  find(): Promise<ImageInputSettingsRecord | null>;
  save(
    input: ImageInputSettingsUpdate,
  ): Promise<
    { status: "ok"; value: ImageInputSettingsRecord } | { status: "conflict" }
  >;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
