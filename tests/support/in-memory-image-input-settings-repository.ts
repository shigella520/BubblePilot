import type {
  ImageInputSettingsRecord,
  ImageInputSettingsRepository,
} from "../../modules/ai/image-input-settings-repository.js";
import type { ImageInputSettingsUpdate } from "../../modules/ai/image-input-settings-types.js";

export class InMemoryImageInputSettingsRepository implements ImageInputSettingsRepository {
  private value: ImageInputSettingsRecord | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  find(): Promise<ImageInputSettingsRecord | null> {
    return Promise.resolve(
      this.value === null ? null : structuredClone(this.value),
    );
  }

  save(input: ImageInputSettingsUpdate) {
    if (input.expectedVersion !== (this.value?.version ?? 0))
      return Promise.resolve({ status: "conflict" as const });
    this.value = {
      enabled: input.enabled,
      includeAttachments: input.includeAttachments,
      includeLinkPreviewImages: input.includeLinkPreviewImages,
      trustedLinkPreviewHosts: input.trustedLinkPreviewHosts,
      maxCurrentAttachments: input.maxCurrentAttachments,
      maxHistoryImages: input.maxHistoryImages,
      maxTotalImages: input.maxTotalImages,
      maxImageBytes: input.maxImageBytes,
      maxTotalBytes: input.maxTotalBytes,
      fetchTimeoutMs: input.fetchTimeoutMs,
      detail: input.detail,
      version: (this.value?.version ?? 0) + 1,
      updatedAt: this.now().toISOString(),
    };
    return Promise.resolve({
      status: "ok" as const,
      value: structuredClone(this.value),
    });
  }

  isReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
