/** Keep list export and the default canvas on the same persisted version. */
export function selectWorkflowVersion<
  T extends { version: number; status: string },
>(
  versions: readonly T[],
  publishedVersion: number | null,
  requestedVersion?: number,
): T | undefined {
  const ordered = [...versions].sort((a, b) => b.version - a.version);
  return (
    ordered.find((item) => item.version === requestedVersion) ??
    ordered.find((item) => item.version === publishedVersion) ??
    ordered.find((item) => item.status === "validated") ??
    ordered[0]
  );
}
