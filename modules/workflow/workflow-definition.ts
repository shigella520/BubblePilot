import { z } from "zod";

import { actionBlockDefinitions } from "./action-blocks.js";
import { valueRefSchema } from "./workflow-graph.js";

const canvasNodeFields = {
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  inputs: z.record(z.string(), valueRefSchema).optional(),
};

const nodeIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const nextNodeIdSchema = nodeIdSchema;
const variableNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/);

const conditionNodeSchema = z.object({
  ...canvasNodeFields,
  id: nodeIdSchema,
  type: z.literal("condition"),
  version: z.literal(1),
  config: z.object({
    field: z.enum([
      "message.text",
      "message.senderId",
      "message.contentType",
      "message.linkPreviewStatus",
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

const messageTriggerNodeSchema = z.object({
  ...canvasNodeFields,
  id: z.literal("message-trigger"),
  type: z.literal("message-trigger"),
  version: z.literal(1),
  config: z.object({
    provider: z.string().max(64).default(""),
    chatIds: z.array(z.string().max(200)).max(50).default([]),
    senderIds: z.array(z.string().max(200)).max(50).default([]),
    contentTypes: z
      .array(z.enum(["text", "attachment", "mixed", "unknown"]))
      .max(4)
      .default([]),
    includeFromMe: z.boolean().default(false),
    enabled: z.boolean().default(false),
    text: z
      .object({
        kind: z.enum(["keyword", "prefix", "regex"]),
        value: z.string().max(2_000),
        caseSensitive: z.boolean().default(false),
      })
      .nullable()
      .default(null),
  }),
  onSuccess: nextNodeIdSchema.optional(),
});

const logNodeSchema = z.object({
  ...canvasNodeFields,
  id: nodeIdSchema,
  type: z.literal("log"),
  version: z.literal(1),
  config: z.object({
    message: z.string().min(1).max(500),
  }),
  onSuccess: nextNodeIdSchema,
});

const setVariableNodeSchema = z.object({
  ...canvasNodeFields,
  id: nodeIdSchema,
  type: z.literal("set-variable"),
  version: z.literal(1),
  config: z.object({
    name: variableNameSchema,
    valueTemplate: z.string().max(4_000),
  }),
  onSuccess: nextNodeIdSchema,
});

const renderTextNodeSchema = z.object({
  ...canvasNodeFields,
  id: nodeIdSchema,
  type: z.literal("render-text"),
  version: z.literal(1),
  config: z.object({
    template: z.string().min(1).max(12_000),
  }),
  onSuccess: nextNodeIdSchema,
});

const loadContextNodeSchema = z.object({
  ...canvasNodeFields,
  id: nodeIdSchema,
  type: z.literal("load-context"),
  version: z.literal(1),
  config: z
    .object({
      messageLimit: z.number().int().min(1).max(50).default(10),
      characterLimit: z.number().int().min(100).max(20_000).default(6_000),
      // Accepted only for one-time legacy definition migration; runtime ignores them.
      includeFromMe: z.boolean().default(true),
      summaryEnabled: z.boolean().default(false),
      summaryProviderRouteId: z
        .union([z.string().uuid(), z.literal("")])
        .optional(),
      compressionBatchSize: z.number().int().min(1).max(50).default(10),
    })
    .superRefine((config, context) => {
      if (
        config.summaryEnabled &&
        (config.summaryProviderRouteId === undefined ||
          config.summaryProviderRouteId === "")
      ) {
        context.addIssue({
          code: "custom",
          path: ["summaryProviderRouteId"],
          message:
            "A summary Provider route is required when history summary is enabled.",
        });
      }
    }),
  onSuccess: nextNodeIdSchema,
  onFailure: nextNodeIdSchema.optional(),
});

const aiChatNodeSchema = z.object({
  ...canvasNodeFields,
  id: nodeIdSchema,
  type: z.literal("ai-chat"),
  version: z.literal(1),
  config: z.object({
    providerRouteId: z.string().uuid(),
    systemPrompt: z.string().max(12_000).default(""),
    promptTemplate: z.string().min(1).max(12_000),
    includeLoadedContext: z.boolean().default(true),
    maxOutputTokens: z.number().int().min(1).max(8_192).default(1_024),
    maxOutputCharacters: z.number().int().min(1).max(12_000).default(4_000),
    temperature: z.number().min(0).max(2).nullable().default(null),
    webSearch: z.enum(["disabled", "auto", "required"]).optional(),
    webSearchSources: z.enum(["full", "compact", "hidden"]).default("full"),
    outputFormat: z.enum(["text", "json"]).default("text"),
    outputVariable: variableNameSchema.default("aiReply"),
  }),
  onSuccess: nextNodeIdSchema,
  onFailure: nextNodeIdSchema.optional(),
});

const replyNodeSchema = z.object({
  ...canvasNodeFields,
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
  ...canvasNodeFields,
  id: nodeIdSchema,
  type: z.literal("end"),
  version: z.literal(1),
  config: z.object({
    result: z.enum(["succeeded", "skipped"]).default("succeeded"),
  }),
});

export const workflowNodeSchema = z.discriminatedUnion("type", [
  messageTriggerNodeSchema,
  conditionNodeSchema,
  logNodeSchema,
  setVariableNodeSchema,
  renderTextNodeSchema,
  loadContextNodeSchema,
  aiChatNodeSchema,
  replyNodeSchema,
  endNodeSchema,
]);

export const workflowDefinitionSchema = z.object({
  schemaVersion: z.literal("1"),
  name: z.string().min(1).max(120),
  startNodeId: nodeIdSchema,
  maxSteps: z.number().int().min(1).max(128).default(64),
  nodes: z.array(workflowNodeSchema).min(1).max(64),
});

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

function targets(node: WorkflowNode): readonly string[] {
  switch (node.type) {
    case "message-trigger":
      return node.onSuccess === undefined ? [] : [node.onSuccess];
    case "condition":
      return [node.onTrue, node.onFalse];
    case "log":
    case "set-variable":
    case "render-text":
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
  const contextTemplatePaths = new Set([
    "context.event.provider",
    "context.event.message.text",
    "context.event.message.senderId",
    "context.event.message.providerMessageId",
    "context.event.message.sentAt",
    "context.event.message.contentType",
    "context.event.message.isFromMe",
    "context.event.message.attachments",
    "context.event.message.attachmentCount",
    "context.event.message.linkPreview",
    "context.event.message.linkPreview.status",
    "context.event.message.linkPreview.items",
    "context.event.message.linkPreview.count",
    "context.event.message.linkPreview.primary",
    "context.event.message.linkPreview.primary.url",
    "context.event.message.linkPreview.primary.title",
    "context.event.message.linkPreview.primary.summary",
    "context.event.message.linkPreview.primary.siteName",
    "context.event.chat.providerChatId",
    "context.event.chat.type",
    "context.event.chat.displayName",
    "context.history.messages",
    "context.history.count",
    "context.history.participants",
  ]);
  const allowedTemplateKeys = new Set<string>([
    "message.text",
    "message.senderId",
    "message.providerMessageId",
    "message.contentType",
    "message.linkPreviewStatus",
    "message.linkPreviewUrl",
    "message.linkPreviewTitle",
    "message.linkPreviewSummary",
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

  const blocksByType = new Map(
    actionBlockDefinitions.map((block) => [block.type, block]),
  );
  for (const node of definition.nodes) {
    if (node.type === "render-text") {
      const pattern = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.-]*)\s*\}\}/gu;
      for (const match of node.config.template.matchAll(pattern)) {
        const path = match[1];
        if (path === undefined) continue;
        if (contextTemplatePaths.has(path)) continue;
        const outputPath =
          /^context\.outputs\.([a-z][a-z0-9-]{0,63})\.([a-zA-Z][a-zA-Z0-9_-]{0,63})$/u.exec(
            path,
          );
        if (outputPath === null) {
          throw new Error(
            `Node '${node.id}' text template uses unsupported Context path '${path}'.`,
          );
        }
        const sourceNodeId = outputPath[1];
        const outputName = outputPath[2];
        const source =
          sourceNodeId === undefined ? undefined : nodes.get(sourceNodeId);
        const sourceBlock =
          source === undefined ? undefined : blocksByType.get(source.type);
        if (
          source === undefined ||
          outputName === undefined ||
          !sourceBlock?.outputs.some((output) => output.name === outputName)
        ) {
          throw new Error(
            `Node '${node.id}' text template references unknown output '${sourceNodeId ?? ""}.${outputName ?? ""}'.`,
          );
        }
      }
      if (node.config.template.replace(pattern, "").match(/\{\{|\}\}/u)) {
        throw new Error(
          `Node '${node.id}' text template contains invalid template syntax.`,
        );
      }
    }
    for (const [inputName, reference] of Object.entries(node.inputs ?? {})) {
      if (reference.kind !== "output") continue;
      const source = nodes.get(reference.blockId);
      if (!source) {
        throw new Error(
          `Node '${node.id}' input '${inputName}' references missing node '${reference.blockId}'.`,
        );
      }
      const sourceBlock = blocksByType.get(source.type);
      const targetBlock = blocksByType.get(node.type);
      const sourcePort = sourceBlock?.outputs.find(
        (port) => port.name === reference.port,
      );
      const targetPort = targetBlock?.inputs.find(
        (port) => port.name === inputName,
      );
      if (!sourcePort || !targetPort) {
        throw new Error(
          `Node '${node.id}' input '${inputName}' references unknown output '${reference.blockId}.${reference.port}'.`,
        );
      }
      if (
        sourcePort.type !== targetPort.type &&
        !(sourcePort.type === "json" && targetPort.type === "string")
      ) {
        throw new Error(
          `Node '${node.id}' input '${inputName}' has an incompatible output reference.`,
        );
      }
    }
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
  const definition = workflowDefinitionSchema.parse(value);
  validateSemantics(definition);
  return definition;
}

export function workflowNodeTargets(node: WorkflowNode): readonly string[] {
  return targets(node);
}
