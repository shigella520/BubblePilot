import type { AttachmentHandling } from "../attachments/attachment-policy.js";
import { pluginError, type InstalledPlugin } from "./plugin-types.js";
export function attachmentTargets(plugins: readonly InstalledPlugin[]) {
  return plugins
    .filter((p) => p.enabled)
    .flatMap((p) =>
      Object.keys(p.config.connections).flatMap((server) => {
        const tools = p.config.tools.filter(
          (t) =>
            t.server === server &&
            !p.config.disabledTools.includes(`${server}/${t.definition.name}`),
        );
        if (
          !tools.some(
            (t) =>
              t.definition.name === "prepare_sandbox" &&
              t.attachmentTransferVersion === 1,
          ) ||
          !["prepare_sandbox", "run_command", "read_file", "write_file"].every(
            (name) => tools.some((t) => t.definition.name === name),
          )
        )
          return [];
        return [
          { pluginId: p.id, pluginName: p.name, server, version: 1 as const },
        ];
      }),
    );
}
export function assertAttachmentBinding(
  plugins: readonly InstalledPlugin[],
  config: AttachmentHandling,
) {
  if (
    !attachmentTargets(plugins).some(
      (t) => t.pluginId === config.pluginId && t.server === config.server,
    )
  )
    pluginError("ATTACHMENT_TARGET_UNAVAILABLE", 409);
}
