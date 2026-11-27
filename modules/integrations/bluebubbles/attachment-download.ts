import type { BlueBubblesSettingsService } from "./settings-service.js";
import { AttachmentError } from "../../attachments/attachment-policy.js";
/** Gateway credentials remain in this adapter; redirects must never receive them. */
export class BlueBubblesAttachmentDownloader {
  constructor(
    private readonly settings: Pick<BlueBubblesSettingsService, "resolve">,
    private readonly request: typeof fetch = fetch,
  ) {}
  /**
   * original=false asks the gateway for its compatible rendition (for
   * example HEIC photos as JPEG). Used only where a target cannot accept the
   * original format; the bytes are staged temporarily and never persisted.
   */
  async download(
    id: string,
    signal: AbortSignal,
    options: { original?: boolean } = {},
  ) {
    const settings = await this.settings.resolve();
    const url = new URL(
      `/api/v1/attachment/${encodeURIComponent(id)}/download`,
      settings.serverUrl + "/",
    );
    url.searchParams.set("password", settings.accessToken);
    url.searchParams.set(
      "original",
      options.original === false ? "false" : "true",
    );
    const response = await this.request(url, {
      signal,
      redirect: "manual",
      headers: { accept: "application/octet-stream" },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new AttachmentError(
        response.status === 404 || response.status === 410
          ? "ATTACHMENT_UNAVAILABLE"
          : "ATTACHMENT_DOWNLOAD_FAILED",
      );
    }
    return response;
  }
}
