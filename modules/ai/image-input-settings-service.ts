import type { ImageInputSettingsRepository } from "./image-input-settings-repository.js";
import type {
  ImageInputRuntimeSettings,
  ImageInputSettingsUpdate,
  ImageInputSettingsView,
} from "./image-input-settings-types.js";

export class ImageInputSettingsService {
  constructor(
    readonly repository: ImageInputSettingsRepository,
    private readonly fallback: ImageInputRuntimeSettings,
  ) {}

  async view(): Promise<ImageInputSettingsView> {
    const stored = await this.repository.find();
    return stored === null
      ? { ...this.fallback, source: "defaults", version: 0, updatedAt: null }
      : { ...stored, source: "database" };
  }

  async resolve(): Promise<ImageInputRuntimeSettings> {
    const stored = await this.repository.find();
    if (stored === null) return this.fallback;
    return {
      enabled: stored.enabled,
      includeAttachments: stored.includeAttachments,
      includeLinkPreviewImages: stored.includeLinkPreviewImages,
      trustedLinkPreviewHosts: stored.trustedLinkPreviewHosts,
      maxCurrentAttachments: stored.maxCurrentAttachments,
      maxHistoryImages: stored.maxHistoryImages,
      maxTotalImages: stored.maxTotalImages,
      maxImageBytes: stored.maxImageBytes,
      maxTotalBytes: stored.maxTotalBytes,
      fetchTimeoutMs: stored.fetchTimeoutMs,
      detail: stored.detail,
    };
  }

  async update(
    input: ImageInputSettingsUpdate,
  ): Promise<
    { status: "ok"; value: ImageInputSettingsView } | { status: "conflict" }
  > {
    const result = await this.repository.save(input);
    return result.status === "conflict"
      ? result
      : { status: "ok", value: { ...result.value, source: "database" } };
  }
}
