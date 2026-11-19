/** Built-in results only. Never persist free-form messages as audit error codes. */
export function safeBuiltinFailureCode(
  value: unknown,
  fallback = "AI_AGENT_TOOL_FAILED",
): string {
  return typeof value === "string" &&
    /^(?:AI_|IMAGE_|FILE_|ATTACHMENT_|MEMORY_|TASK_|MEME_)[A-Z0-9_]{1,90}$/.test(
      value,
    )
    ? value
    : fallback;
}
