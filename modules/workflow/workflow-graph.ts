import { z } from "zod";
import {
  actionBlockDefinitions,
  type ActionValueType,
} from "./action-blocks.js";

export const contextValueSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.record(z.string(), contextValueSchema),
    z.array(contextValueSchema),
  ]),
);

export const valueRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: contextValueSchema }),
  z.object({
    kind: z.literal("path"),
    path: z.string().regex(/^context\.[a-zA-Z0-9_.]+$/),
  }),
  z.object({
    kind: z.literal("output"),
    blockId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    port: z.string().min(1).max(64),
  }),
]);

const nodeId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const edgeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  source: nodeId,
  sourcePort: z.string().min(1).max(64),
  target: nodeId,
  targetPort: z.string().min(1).max(64),
  kind: z.enum(["data", "success", "failure", "branch"]),
});

export const workflowGraphSchema = z.object({
  // The action-block graph is the only supported workflow contract.
  schemaVersion: z.literal("1"),
  name: z.string().min(1).max(120),
  startNodeId: nodeId,
  maxSteps: z.number().int().min(1).max(128).default(64),
  nodes: z
    .array(
      z.object({
        id: nodeId,
        type: z.string().min(1).max(64),
        version: z.number().int().min(1),
        position: z.object({ x: z.number(), y: z.number() }),
        config: z.record(z.string(), contextValueSchema).default({}),
        inputs: z.record(z.string(), valueRefSchema).default({}),
      }),
    )
    .min(1)
    .max(64),
  edges: z.array(edgeSchema).max(256),
});

export type WorkflowGraphDefinition = z.infer<typeof workflowGraphSchema>;
export type WorkflowGraphNode = WorkflowGraphDefinition["nodes"][number];
export type WorkflowGraphEdge = WorkflowGraphDefinition["edges"][number];
export type ValueRef = z.infer<typeof valueRefSchema>;

const contextPaths = new Set([
  "context.event.message.text",
  "context.event.message.senderId",
  "context.event.chat.providerChatId",
  "context.history.messages",
  "context.history.count",
  "context.history.participants",
]);

export function validateWorkflowGraph(value: unknown): WorkflowGraphDefinition {
  const definition = workflowGraphSchema.parse(value);
  const blocks = new Map(
    actionBlockDefinitions.map((item) => [
      `${item.type}@${item.version}`,
      item,
    ]),
  );
  const nodes = new Map<string, WorkflowGraphNode>();
  for (const node of definition.nodes) {
    if (nodes.has(node.id))
      throw new Error(`Workflow node id '${node.id}' is duplicated.`);
    const block = blocks.get(`${node.type}@${node.version}`);
    if (!block)
      throw new Error(`Unknown action block '${node.type}@${node.version}'.`);
    for (const input of block.inputs) {
      if (input.required && node.inputs[input.name] === undefined)
        throw new Error(`Node '${node.id}' input '${input.name}' is required.`);
    }
    for (const [name, ref] of Object.entries(node.inputs)) {
      if (!block.inputs.some((port) => port.name === name))
        throw new Error(`Node '${node.id}' has unknown input '${name}'.`);
      if (
        ref.kind === "path" &&
        !contextPaths.has(ref.path) &&
        !/^context\.(variables|outputs)\.[a-zA-Z0-9_.-]+$/.test(ref.path)
      ) {
        throw new Error(
          `Node '${node.id}' references unsupported Context path '${ref.path}'.`,
        );
      }
    }
    nodes.set(node.id, node);
  }
  if (!nodes.has(definition.startNodeId))
    throw new Error("The workflow start node does not exist.");
  const controlEdges = definition.edges.filter((edge) => edge.kind !== "data");
  for (const edge of definition.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target)
      throw new Error(`Edge '${edge.id}' references a missing node.`);
    const block = blocks.get(`${source.type}@${source.version}`)!;
    if (edge.kind === "data") {
      const output = block.outputs.find(
        (port) => port.name === edge.sourcePort,
      );
      const targetBlock = blocks.get(`${target.type}@${target.version}`)!;
      const input = targetBlock.inputs.find(
        (port) => port.name === edge.targetPort,
      );
      if (!output || !input)
        throw new Error(`Edge '${edge.id}' references an unknown port.`);
      if (
        output.type !== input.type &&
        !(output.type === "json" && input.type === "string")
      )
        throw new Error(`Edge '${edge.id}' has incompatible port types.`);
    }
  }
  const adjacency = new Map<string, string[]>();
  for (const edge of controlEdges)
    adjacency.set(edge.source, [
      ...(adjacency.get(edge.source) ?? []),
      edge.target,
    ]);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id))
      throw new Error(`Workflow cycle detected at node '${id}'.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  visit(definition.startNodeId);
  if (visited.size !== nodes.size)
    throw new Error(
      `Workflow contains unreachable nodes: ${[...nodes.keys()].filter((id) => !visited.has(id)).join(", ")}.`,
    );
  return definition;
}

export function actionPortType(type: string): ActionValueType | null {
  for (const definition of actionBlockDefinitions) {
    for (const port of [...definition.inputs, ...definition.outputs])
      if (port.name === type) return port.type;
  }
  return null;
}
