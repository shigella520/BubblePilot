/** Only same-app paths are accepted, never another origin ("//host"). */
export function safeRedirect(value: unknown): string {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/login")
    ? value
    : "/";
}
