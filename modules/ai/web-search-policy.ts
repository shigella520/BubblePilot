/** Legacy `required` means enabled; search never forces a tool call. */
export function normalizeWebSearchPolicy(value: unknown): "disabled" | "auto" {
  return value === "auto" || value === "required" ? "auto" : "disabled";
}
