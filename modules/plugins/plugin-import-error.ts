/** Persist only controlled diagnostics, never git stderr, URLs, or credentials. */
export function pluginImportErrorCode(error: unknown): string {
  const allowed = new Set([
    "PLUGIN_NO_PLUGIN_MANIFEST",
    "PLUGIN_ARCHIVE_TOO_LARGE",
    "PLUGIN_TEXT_TOO_LARGE",
    "PLUGIN_INVALID_ZIP",
    "PLUGIN_UNSAFE_PATH",
    "PLUGIN_SYMLINK_DENIED",
    "PLUGIN_UNSAFE_ARCHIVE_ENTRY",
    "PLUGIN_NETWORK_TARGET_DENIED",
    "PLUGIN_INVALID_GIT_URL",
    "PLUGIN_GIT_FAILED",
    "PLUGIN_GIT_TIMEOUT",
  ]);
  const code =
    error instanceof Error && "code" in error ? error.code : undefined;
  if (typeof code === "string" && allowed.has(code)) return code;
  if (error instanceof Error && allowed.has(error.message))
    return error.message;
  return "IMPORT_FAILED";
}
