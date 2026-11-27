import type { AttachmentHandling } from "../attachments/attachment-policy.js";
import { pluginError, type InstalledPlugin } from "./plugin-types.js";
import {
  requiredTransportTools,
  transportKind,
  transportWorkspacePrefix,
  type TransportKind,
} from "./plugin-transport.js";

export interface AttachmentTarget {
  pluginId: string;
  pluginName: string;
  server: string;
  version: 1;
  kind: TransportKind;
  anchorTool: string;
  workspacePrefix: string;
  /** Generators only; sandboxes accept any type BP's attachment policy allows. */
  mimeTypes?: string[];
}

export function attachmentTargets(
  plugins: readonly InstalledPlugin[],
): AttachmentTarget[] {
  return plugins
    .filter((p) => p.enabled)
    .flatMap((p) =>
      Object.keys(p.config.connections).flatMap((server) => {
        const tools = p.config.tools.filter(
          (t) =>
            t.server === server &&
            !p.config.disabledTools.includes(`${server}/${t.definition.name}`),
        );
        return tools.flatMap((anchor): AttachmentTarget[] => {
          if (anchor.attachmentTransferVersion !== 1) return [];
          if (
            !requiredTransportTools(anchor, "attachment").every((name) =>
              tools.some((t) => t.definition.name === name),
            )
          )
            return [];
          const kind = transportKind(anchor);
          if (kind === "generator" && !anchor.attachmentMimeTypes?.length)
            return [];
          return [
            {
              pluginId: p.id,
              pluginName: p.name,
              server,
              version: 1,
              kind,
              anchorTool: anchor.definition.name,
              workspacePrefix: transportWorkspacePrefix(anchor),
              ...(kind === "generator"
                ? { mimeTypes: [...anchor.attachmentMimeTypes!] }
                : {}),
            },
          ];
        });
      }),
    );
}

export function findAttachmentTarget(
  plugins: readonly InstalledPlugin[],
  binding: { pluginId: string; server: string },
  kind: TransportKind,
): AttachmentTarget {
  const target = attachmentTargets(plugins).find(
    (t) =>
      t.pluginId === binding.pluginId &&
      t.server === binding.server &&
      t.kind === kind,
  );
  if (!target) pluginError("ATTACHMENT_TARGET_UNAVAILABLE", 409);
  return target;
}

/** Attachment handling binds a sandbox target. */
export function assertAttachmentBinding(
  plugins: readonly InstalledPlugin[],
  config: AttachmentHandling,
) {
  findAttachmentTarget(plugins, config, "sandbox");
}
