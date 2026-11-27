/** Fixed, model-safe error codes. Messages never carry upstream text or prompts. */
export class ToolError extends Error {}

/** Export error codes BubblePilot's client maps (modules/plugins/plugin-mcp.ts). */
export const imageExportErrors = new Set([
  "image_path_denied",
  "image_not_found",
  "image_not_regular",
  "image_too_large",
  "image_invalid",
  "image_animated",
  "image_pixels_exceeded",
  "image_changed",
  "image_export_failed",
  "sandbox_busy",
  "session_expired_or_invalidated",
]);

/** Tool-level failures returned to the model. */
export const toolErrors = new Set([
  "upstream_timeout",
  "upstream_unavailable",
  "content_rejected",
  "quota_exceeded",
  "image_not_found",
  "input_type_unsupported",
  "invalid_arguments",
  "image_path_denied",
  "image_invalid",
  "image_animated",
  "image_pixels_exceeded",
  "image_too_large",
  "preview_too_large",
  "workspace_full",
  "session_expired_or_invalidated",
]);
