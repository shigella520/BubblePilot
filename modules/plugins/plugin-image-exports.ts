import {
  type ImageReply,
  replyFileTypes,
  allowedReplyFileTypes,
  type ReplyFileType,
} from "../generated-images/image-policy.js";
import { pluginError, type InstalledPlugin } from "./plugin-types.js";
import {
  requiredTransportTools,
  transportKind,
  transportWorkspacePrefix,
  type TransportKind,
} from "./plugin-transport.js";

export interface ImageExportTarget {
  pluginId: string;
  pluginName: string;
  server: string;
  version: 1;
  kind: TransportKind;
  anchorTool: string;
  workspacePrefix: string;
  fileTypes: ReplyFileType[];
}

export function imageExportTargets(
  plugins: readonly InstalledPlugin[],
): ImageExportTarget[] {
  return plugins
    .filter((p) => p.enabled)
    .flatMap((p) =>
      Object.keys(p.config.connections).flatMap((server) => {
        const tools = p.config.tools.filter(
          (t) =>
            t.server === server &&
            !p.config.disabledTools.includes(`${server}/${t.definition.name}`),
        );
        return tools.flatMap((anchor): ImageExportTarget[] => {
          if (anchor.imageExportVersion !== 1 && anchor.fileExportVersion !== 1)
            return [];
          if (
            !requiredTransportTools(anchor, "export").every((name) =>
              tools.some((t) => t.definition.name === name),
            )
          )
            return [];
          return [
            {
              pluginId: p.id,
              pluginName: p.name,
              server,
              version: 1,
              kind: transportKind(anchor),
              anchorTool: anchor.definition.name,
              workspacePrefix: transportWorkspacePrefix(anchor),
              fileTypes:
                anchor.fileExportVersion === 1 ? [...replyFileTypes] : ["png"],
            },
          ];
        });
      }),
    );
}

export function findImageExportTarget(
  plugins: readonly InstalledPlugin[],
  binding: { pluginId: string; server: string },
  kind: TransportKind,
  fileTypes: readonly ReplyFileType[],
): ImageExportTarget {
  const target = imageExportTargets(plugins).find(
    (t) =>
      t.pluginId === binding.pluginId &&
      t.server === binding.server &&
      t.kind === kind &&
      fileTypes.every((type) => t.fileTypes.includes(type)),
  );
  if (!target) pluginError("IMAGE_EXPORT_TARGET_UNAVAILABLE", 409);
  return target;
}

/** Image reply (attachment output) binds a sandbox target. */
export function assertImageExportBinding(
  plugins: readonly InstalledPlugin[],
  config: ImageReply,
) {
  findImageExportTarget(
    plugins,
    config,
    "sandbox",
    allowedReplyFileTypes(config),
  );
}
