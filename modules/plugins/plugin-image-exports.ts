import {
  type ImageReply,
  replyFileTypes,
  allowedReplyFileTypes,
} from "../generated-images/image-policy.js";
import { pluginError, type InstalledPlugin } from "./plugin-types.js";
export function imageExportTargets(plugins: readonly InstalledPlugin[]) {
  return plugins
    .filter((p) => p.enabled)
    .flatMap((p) =>
      Object.keys(p.config.connections).flatMap((server) => {
        const tools = p.config.tools.filter(
          (t) =>
            t.server === server &&
            !p.config.disabledTools.includes(`${server}/${t.definition.name}`),
        );
        return tools.some(
          (t) =>
            t.definition.name === "prepare_sandbox" &&
            (t.imageExportVersion === 1 || t.fileExportVersion === 1),
        ) && tools.some((t) => t.definition.name === "run_command")
          ? [
              {
                pluginId: p.id,
                pluginName: p.name,
                server,
                version: 1 as const,
                fileTypes: tools.some(
                  (t) =>
                    t.definition.name === "prepare_sandbox" &&
                    t.fileExportVersion === 1,
                )
                  ? [...replyFileTypes]
                  : ["png"],
              },
            ]
          : [];
      }),
    );
}
export function assertImageExportBinding(
  plugins: readonly InstalledPlugin[],
  config: ImageReply,
) {
  if (
    !imageExportTargets(plugins).some(
      (t) =>
        t.pluginId === config.pluginId &&
        t.server === config.server &&
        allowedReplyFileTypes(config).every((type) =>
          t.fileTypes.includes(type),
        ),
    )
  )
    pluginError("IMAGE_EXPORT_TARGET_UNAVAILABLE", 409);
}
