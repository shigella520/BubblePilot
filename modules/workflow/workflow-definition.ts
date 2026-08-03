import { z } from "zod";

const nodeIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const nextNodeIdSchema = nodeIdSchema;
const variableNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/);

const conditionNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("condition"),
  version: z.literal(1),
  config: z.object({
    field: z.enum([
      "message.text",
      "message.senderId",
      "message.contentType",
      "chat.providerChatId",
    ]),
    operator: z.enum([
      "equals",
      "contains",
      "starts-with",
      "matches",
      "exists",
    ]),
    value: z.string().max(2_000).optional(),
    caseSensitive: z.boolean().default(false),
  }),
  onTrue: nextNodeIdSchema,
  onFalse: nextNodeIdSchema,
});

const logNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("log"),
  version: z.literal(1),
  config: z.object({
    message: z.string().min(1).max(500),
  }),
  onSuccess: nextNodeIdSchema,
});

const setVariableNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("set-variable"),
  version: z.literal(1),
  config: z.object({
    name: variableNameSchema,
    valueTemplate: z.string().max(4_000),
  }),
  onSuccess: nextNodeIdSchema,
});

const loadContextNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("load-context"),
  version: z.literal(1),
  config: z.object({
    messageLimit: z.number().int().min(1).max(50).default(10),
    characterLimit: z.number().int().min(100).max(20_000).default(6_000),
    includeFromMe: z.boolean().default(true),
  }),
  onSuccess: nextNodeIdSchema,
  onFailure: nextNodeIdSchema.optional(),
});

const aiChatNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("ai-chat"),
  version: z.literal(1),
  config: z.object({
    providerRouteId: z.string().uuid(),
    systemPrompt: z.string().max(12_000).default(""),
    promptTemplate: z.string().min(1).max(12_000),
    includeLoadedContext: z.boolean().default(true),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    maxOutputTokens: z.number().int().min(1).max(8_192).default(1_024),
    maxOutputCharacters: z.number().int().min(1).max(12_000).default(4_000),
    temperature: z.number().min(0).max(2).nullable().default(null),
    outputFormat: z.enum(["text", "json"]).default("text"),
    outputVariable: variableNameSchema.default("aiReply"),
  }),
  onSuccess: nextNodeIdSchema,
  onFailure: nextNodeIdSchema.optional(),
});

const replyNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("reply"),
  version: z.literal(1),
  config: z.object({
    text: z.string().min(1).max(4_000),
    replyToSourceMessage: z.boolean().default(false),
    retry: z
      .object({
        maxAttempts: z.number().int().min(1).max(5).default(2),
        initialDelayMs: z.number().int().min(0).max(5_000).default(250),
      })
      .default({ maxAttempts: 2, initialDelayMs: 250 }),
  }),
  onSuccess: nextNodeIdSchema,
  onFailure: nextNodeIdSchema.optional(),
});

const endNodeSchema = z.object({
  id: nodeIdSchema,
  type: z.literal("end"),
  version: z.literal(1),
  config: z.object({
    result: z.enum(["succeeded", "skipped"]).default("succeeded"),
  }),
});

export const workflowNodeSchema = z.discriminatedUnion("type", [
  conditionNodeSchema,
  logNodeSchema,
  setVariableNodeSchema,
  loadContextNodeSchema,
  aiChatNodeSchema,
  replyNodeSchema,
  endNodeSchema,
]);

const rawWorkflowDefinitionSchema = z.object({
  schemaVersion: z.literal("1"),
  name: z.string().min(1).max(120),
  startNodeId: nodeIdSchema,
  maxSteps: z.number().int().min(1).max(128).default(64),
  maxExecutionMs: z.number().int().min(1_000).max(300_000).default(60_000),
  nodes: z.array(workflowNodeSchema).min(1).max(64),
});

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowDefinition = z.infer<typeof rawWorkflowDefinitionSchema>;

function targets(node: WorkflowNode): readonly string[] {
  switch (node.type) {
    case "condition":
      return [node.onTrue, node.onFalse];
    case "log":
    case "set-variable":
      return [node.onSuccess];
    case "load-context":
    case "ai-chat":
      return node.onFailure === undefined
        ? [node.onSuccess]
        : [node.onSuccess, node.onFailure];
    case "reply":
      return node.onFailure === undefined
        ? [node.onSuccess]
        : [node.onSuccess, node.onFailure];
    case "end":
      return [];
  }
}

function validateSemantics(definition: WorkflowDefinition): void {
  const allowedTemplateKeys = new Set<string>([
    "message.text",
    "message.senderId",
    "message.providerMessageId",
    "message.contentType",
    "chat.providerChatId",
  ]);
  for (const node of definition.nodes) {
    if (node.type === "set-variable") {
      allowedTemplateKeys.add(`variables.${node.config.name}`);
    }
    if (node.type === "ai-chat") {
      allowedTemplateKeys.add(`variables.${node.config.outputVariable}`);
    }
  }
  const validateTemplate = (
    nodeId: string,
    template: string,
    field: string,
  ): void => {
    const pattern = /\{\{\s*([a-zA-Z][a-zA-Z0-9._]*)\s*\}\}/gu;
    for (const match of template.matchAll(pattern)) {
      const key = match[1];
      if (key !== undefined && !allowedTemplateKeys.has(key)) {
        throw new Error(
          `Node '${nodeId}' ${field} uses unsupported template key '${key}'.`,
        );
      }
    }
    if (template.replace(pattern, "").match(/\{\{|\}\}/u) !== null) {
      throw new Error(`Node '${nodeId}' ${field} has invalid template syntax.`);
    }
  };
  const nodes = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    if (nodes.has(node.id)) {
      throw new Error(`Workflow node id '${node.id}' is duplicated.`);
    }
    if (
      node.type === "condition" &&
      node.config.operator !== "exists" &&
      node.config.value === undefined
    ) {
      throw new Error(`Condition node '${node.id}' requires a value.`);
    }
    if (node.type === "condition" && node.config.operator === "matches") {
      try {
        void new RegExp(
          node.config.value ?? "",
          node.config.caseSensitive ? "u" : "iu",
        );
      } catch {
        throw new Error(
          `Condition node '${node.id}' contains an invalid regex.`,
        );
      }
    }
    if (node.type === "reply") {
      validateTemplate(node.id, node.config.text, "reply text");
    }
    if (node.type === "set-variable") {
      validateTemplate(node.id, node.config.valueTemplate, "value template");
    }
    if (node.type === "ai-chat") {
      validateTemplate(node.id, node.config.systemPrompt, "system prompt");
      validateTemplate(node.id, node.config.promptTemplate, "prompt template");
    }
    nodes.set(node.id, node);
  }

  if (!nodes.has(definition.startNodeId)) {
    throw new Error("The workflow start node does not exist.");
  }
  for (const node of definition.nodes) {
    for (const target of targets(node)) {
      if (!nodes.has(target)) {
        throw new Error(
          `Node '${node.id}' references missing node '${target}'.`,
        );
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      throw new Error(`Workflow cycle detected at node '${nodeId}'.`);
    }
    if (visited.has(nodeId)) {
      return;
    }
    visiting.add(nodeId);
    const node = nodes.get(nodeId);
    if (node === undefined) {
      throw new Error(`Workflow node '${nodeId}' does not exist.`);
    }
    for (const target of targets(node)) {
      visit(target);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  visit(definition.startNodeId);

  if (visited.size !== nodes.size) {
    const unreachable = [...nodes.keys()].filter(
      (nodeId) => !visited.has(nodeId),
    );
    throw new Error(
      `Workflow contains unreachable nodes: ${unreachable.join(", ")}.`,
    );
  }
}

export function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  const definition = rawWorkflowDefinitionSchema.parse(value);
  validateSemantics(definition);
  return definition;
}

export function workflowNodeTargets(node: WorkflowNode): readonly string[] {
  return targets(node);
}
