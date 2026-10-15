/** Data wires are persisted as node input references, not a separate edge list. */
export function workflowDataEdges(
  nodes: readonly {
    id: string;
    inputs?: Record<string, unknown> | undefined;
  }[],
) {
  return nodes.flatMap((node) =>
    Object.entries(node.inputs ?? {}).flatMap(([port, value]) => {
      if (typeof value !== "object" || value === null) return [];
      const ref = value as {
        kind?: unknown;
        blockId?: unknown;
        port?: unknown;
      };
      if (
        ref.kind !== "output" ||
        typeof ref.blockId !== "string" ||
        typeof ref.port !== "string"
      )
        return [];
      return [
        {
          id: `${ref.blockId}-${node.id}-${port}`,
          source: ref.blockId,
          sourceHandle: `output:${ref.port}`,
          target: node.id,
          targetHandle: `input:${port}`,
          kind: "data",
          type: "workflow",
        },
      ];
    }),
  );
}
