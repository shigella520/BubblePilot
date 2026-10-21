import type { TrustedHostsProvider } from "../shared/network-settings.js";
import { ApplicationError } from "../../app/errors.js";
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
    private readonly trustedHosts?: TrustedHostsProvider,
  ) {}

  async view(): Promise<ImageInputSettingsView> {
    const stored = await this.repository.find();
    const shared = this.trustedHosts
      ? { trustedLinkPreviewHosts: await this.trustedHosts() }
      : {};
    return stored === null
      ? {
          ...this.fallback,
          ...shared,
          source: "defaults",
          version: 0,
          updatedAt: null,
        }
      : { ...stored, ...shared, source: "database" };
  }

  async resolve(): Promise<ImageInputRuntimeSettings> {
    const stored = await this.view();
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
    if (this.trustedHosts) {
      const current = await this.trustedHosts();
      if (
        input.trustedLinkPreviewHosts !== undefined &&
        JSON.stringify([...input.trustedLinkPreviewHosts].sort()) !==
          JSON.stringify([...current].sort())
      )
        throw new ApplicationError(
          "NETWORK_SETTINGS_MOVED",
          "Manage trusted Fake-IP hosts in system network settings.",
          409,
        );
      input = { ...input, trustedLinkPreviewHosts: undefined };
    }
    const result = await this.repository.save(input);
    return result.status === "conflict"
      ? result
      : {
          status: "ok",
          value: {
            ...result.value,
            ...(this.trustedHosts
              ? { trustedLinkPreviewHosts: await this.trustedHosts() }
              : {}),
            source: "database",
          },
        };
  }
}
