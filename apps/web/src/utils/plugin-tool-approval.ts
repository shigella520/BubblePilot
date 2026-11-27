export interface DiscoveredTool {
  server: string;
  hash: string;
  definition: { name: string };
}

export const toolApprovalKey = (tool: DiscoveredTool) =>
  `${tool.server}/${tool.definition.name}#${tool.hash}`;

/**
 * After re-discovery, keep approvals whose key (server, name and definition
 * hash) is unchanged. Changed or new tools need an explicit review; nothing
 * previously approved is silently revoked just because a connection was
 * re-tested.
 */
export function retainedApprovals(
  previous: readonly string[],
  discovered: readonly DiscoveredTool[],
): string[] {
  const keep = new Set(previous);
  return discovered.map(toolApprovalKey).filter((key) => keep.has(key));
}
