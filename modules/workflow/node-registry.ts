import { sha256 } from "../../app/canonical-json.js";
import type { AiRoutingService } from "../ai/ai-routing-service.js";
import type { AiChatMessage } from "../ai/ai-types.js";
import type {
  ArchiveRepository,
  ContextMessage,
} from "../archive/archive-repository.js";
import type { ReplyGateway } from "../integrations/bluebubbles/reply-gateway.js";
import type { MessageEnvelope } from "../ingestion/message-envelope.js";
import type { WorkflowNode } from "./workflow-definition.js";
import { WorkflowExecutionError } from "./workflow-errors.js";
import type { WorkflowRepository } from "./workflow-repository.js";

export interface NodeExecutionContext {
  executionId: string;
  correlationId: string;
  envelope: MessageEnvelope;
  deadlineAt: number;
  variables: Record<string, string>;
  history: ContextMessage[];
}

export interface NodeHandlerResult {
  status: "succeeded" | "skipped";
  nextNodeId: string | null;
  completionStatus?: "succeeded" | "skipped";
  outputSummary: Readonly<Record<string, unknown>>;
}

export interface NodeRetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
}

export interface NodeHandler {
  readonly type: WorkflowNode["type"];
  readonly version: number;
  execute(
    node: WorkflowNode,
    context: NodeExecutionContext,
  ): Promise<NodeHandlerResult>;
  retryPolicy(node: WorkflowNode): NodeRetryPolicy;
  failureTarget(node: WorkflowNode): string | null;
}

abstract class BaseNodeHandler implements NodeHandler {
  abstract readonly type: WorkflowNode["type"];
  readonly version = 1;

  abstract execute(
    node: WorkflowNode,
    context: NodeExecutionContext,
  ): Promise<NodeHandlerResult>;

  retryPolicy(node: WorkflowNode): NodeRetryPolicy {
    void node;
    return { maxAttempts: 1, initialDelayMs: 0 };
  }

  failureTarget(node: WorkflowNode): string | null {
    void node;
    return null;
  }

  protected assertType<T extends WorkflowNode["type"]>(
    node: WorkflowNode,
    type: T,
  ): asserts node is Extract<WorkflowNode, { type: T }> {
    if (node.type !== type) {
      throw new WorkflowExecutionError(
        "NODE_TYPE_MISMATCH",
        `Node '${node.id}' was sent to the wrong handler.`,
        false,
      );
    }
  }
}

function messageField(
  envelope: MessageEnvelope,
  field:
    | "message.text"
    | "message.senderId"
    | "message.contentType"
    | "chat.providerChatId",
): string | null {
  switch (field) {
    case "message.text":
      return envelope.message.text;
    case "message.senderId":
      return envelope.message.senderId;
    case "message.contentType":
      return envelope.message.contentType;
    case "chat.providerChatId":
      return envelope.chat.providerChatId;
  }
}

function templateValues(context: NodeExecutionContext): Record<string, string> {
  return {
    "message.text": context.envelope.message.text ?? "",
    "message.senderId": context.envelope.message.senderId ?? "",
    "message.providerMessageId": context.envelope.message.providerMessageId,
    "message.contentType": context.envelope.message.contentType,
    "chat.providerChatId": context.envelope.chat.providerChatId,
    ...Object.fromEntries(
      Object.entries(context.variables).map(([key, value]) => [
        `variables.${key}`,
        value,
      ]),
    ),
  };
}

function renderTemplate(
  template: string,
  context: NodeExecutionContext,
): string {
  const values = templateValues(context);
  return template.replace(
    /\{\{\s*([a-zA-Z][a-zA-Z0-9._]*)\s*\}\}/gu,
    (_match, key: string) => values[key] ?? "",
  );
}

function setVariable(
  context: NodeExecutionContext,
  name: string,
  value: string,
): void {
  const nextVariables = { ...context.variables, [name]: value };
  if (Object.keys(nextVariables).length > 64) {
    throw new WorkflowExecutionError(
      "WORKFLOW_VARIABLE_LIMIT_EXCEEDED",
      "The workflow execution contains too many variables.",
      false,
    );
  }
  const totalCharacters = Object.values(nextVariables).reduce(
    (total, candidate) => total + candidate.length,
    0,
  );
  if (totalCharacters > 32_000) {
    throw new WorkflowExecutionError(
      "WORKFLOW_CONTEXT_TOO_LARGE",
      "The workflow variable context exceeds its character limit.",
      false,
    );
  }
  context.variables[name] = value;
}

class ConditionNodeHandler extends BaseNodeHandler {
  readonly type = "condition" as const;

  execute(
    node: WorkflowNode,
    context: NodeExecutionContext,
  ): Promise<NodeHandlerResult> {
    this.assertType(node, this.type);
    const value = messageField(context.envelope, node.config.field);
    const expected = node.config.value ?? "";
    const candidate = node.config.caseSensitive
      ? value
      : value?.toLocaleLowerCase("en-US");
    const normalizedExpected = node.config.caseSensitive
      ? expected
      : expected.toLocaleLowerCase("en-US");
    let matched: boolean;
    switch (node.config.operator) {
      case "exists":
        matched = value !== null && value.length > 0;
        break;
      case "equals":
        matched = candidate === normalizedExpected;
        break;
      case "contains":
        matched = candidate?.includes(normalizedExpected) ?? false;
        break;
      case "starts-with":
        matched = candidate?.startsWith(normalizedExpected) ?? false;
        break;
      case "matches":
        matched =
          value !== null &&
          new RegExp(expected, node.config.caseSensitive ? "u" : "iu").test(
            value,
          );
        break;
    }
    return Promise.resolve({
      status: "succeeded",
      nextNodeId: matched ? node.onTrue : node.onFalse,
      outputSummary: { matched, field: node.config.field },
    });
  }
}

class LogNodeHandler extends BaseNodeHandler {
  readonly type = "log" as const;

  execute(node: WorkflowNode): Promise<NodeHandlerResult> {
    this.assertType(node, this.type);
    return Promise.resolve({
      status: "succeeded",
      nextNodeId: node.onSuccess,
      outputSummary: { message: node.config.message },
    });
  }
}

class SetVariableNodeHandler extends BaseNodeHandler {
  readonly type = "set-variable" as const;

  execute(
    node: WorkflowNode,
    context: NodeExecutionContext,
  ): Promise<NodeHandlerResult> {
    this.assertType(node, this.type);
    const value = renderTemplate(node.config.valueTemplate, context);
    setVariable(context, node.config.name, value);
    return Promise.resolve({
      status: "succeeded",
      nextNodeId: node.onSuccess,
      outputSummary: {
        variable: node.config.name,
        characters: value.length,
      },
    });
  }
}

class LoadContextNodeHandler extends BaseNodeHandler {
  readonly type = "load-context" as const;

  constructor(private readonly archive: ArchiveRepository) {
    super();
  }

  override failureTarget(node: WorkflowNode): string | null {
    this.assertType(node, this.type);
    return node.onFailure ?? null;
  }

  async execute(
    node: WorkflowNode,
    context: NodeExecutionContext,
  ): Promise<NodeHandlerResult> {
    this.assertType(node, this.type);
    try {
      const messages = await this.archive.loadRecentMessages(
        context.envelope.chat.providerChatId,
        {
          limit: node.config.messageLimit,
          maxCharacters: node.config.characterLimit,
          includeFromMe: node.config.includeFromMe,
          excludeProviderMessageId: context.envelope.message.providerMessageId,
        },
      );
      context.history.splice(0, context.history.length, ...messages);
      return {
        status: "succeeded",
        nextNodeId: node.onSuccess,
        outputSummary: {
          messageCount: messages.length,
          characters: messages.reduce(
            (total, message) => total + message.body.length,
            0,
          ),
          includesSentMessages: messages.some((message) => message.isFromMe),
        },
      };
    } catch (error) {
      throw new WorkflowExecutionError(
        "CONTEXT_LOAD_FAILED",
        "The bounded message context could not be loaded.",
        true,
        false,
        { cause: error },
      );
    }
  }
}

function historyMessage(message: ContextMessage): AiChatMessage {
  return {
    role: message.isFromMe ? "assistant" : "user",
    content:
      message.isFromMe || message.senderId === null
        ? message.body
        : `[${message.senderId}] ${message.body}`,
  };
}

class AiChatNodeHandler extends BaseNodeHandler {
  readonly type = "ai-chat" as const;

  constructor(private readonly routing: AiRoutingService) {
    super();
  }

  override failureTarget(node: WorkflowNode): string | null {
    this.assertType(node, this.type);
    return node.onFailure ?? null;
  }

  async execute(
    node: WorkflowNode,
    context: NodeExecutionContext,
  ): Promise<NodeHandlerResult> {
    this.assertType(node, this.type);
    const remainingMs = context.deadlineAt - Date.now();
    if (remainingMs < 1_000) {
      throw new WorkflowExecutionError(
        "AI_NODE_TIMEOUT",
        "The AI node does not have enough execution time remaining.",
        true,
      );
    }
    const systemPrompt = renderTemplate(node.config.systemPrompt, context);
    const prompt = renderTemplate(node.config.promptTemplate, context);
    if (prompt.trim().length === 0) {
      throw new WorkflowExecutionError(
        "INVALID_AI_PROMPT",
        "The rendered AI prompt is empty.",
        false,
      );
    }
    const messages: AiChatMessage[] = [];
    if (systemPrompt.length > 0) {
      messages.push({ role: "system", content: systemPrompt });
    }
    if (node.config.includeLoadedContext) {
      messages.push(...context.history.map(historyMessage));
    }
    messages.push({ role: "user", content: prompt });

    let result;
    try {
      result = await this.routing.execute({
        executionId: context.executionId,
        nodeId: node.id,
        routeId: node.config.providerRouteId,
        messages,
        maxOutputTokens: node.config.maxOutputTokens,
        temperature: node.config.temperature,
        timeoutMs: Math.min(node.config.timeoutMs, remainingMs),
        maxOutputCharacters: node.config.maxOutputCharacters,
        outputFormat: node.config.outputFormat,
        protectedPrompt: systemPrompt.length === 0 ? null : systemPrompt,
      });
    } catch (error) {
      throw new WorkflowExecutionError(
        "AI_ROUTING_FAILED",
        "The AI provider route could not be executed.",
        true,
        false,
        { cause: error },
      );
    }
    if (result.status === "failed") {
      throw new WorkflowExecutionError(
        result.code,
        result.summary,
        result.retryable,
      );
    }
    setVariable(context, node.config.outputVariable, result.text);
    return {
      status: "succeeded",
      nextNodeId: node.onSuccess,
      outputSummary: {
        ...this.routing.outputSummary(result),
        outputVariable: node.config.outputVariable,
      },
    };
  }
}

function renderReplyTemplate(
  template: string,
  context: NodeExecutionContext,
): string {
  const rendered = renderTemplate(template, context);
  if (rendered.length === 0 || rendered.length > 4_000) {
    throw new WorkflowExecutionError(
      "INVALID_REPLY_OUTPUT",
      "The rendered reply is empty or exceeds the 4,000 character limit.",
      false,
    );
  }
  return rendered;
}

class ReplyNodeHandler extends BaseNodeHandler {
  readonly type = "reply" as const;

  constructor(
    private readonly repository: WorkflowRepository,
    private readonly gateway: ReplyGateway,
  ) {
    super();
  }

  override retryPolicy(node: WorkflowNode): NodeRetryPolicy {
    this.assertType(node, this.type);
    return node.config.retry;
  }

  override failureTarget(node: WorkflowNode): string | null {
    this.assertType(node, this.type);
    return node.onFailure ?? null;
  }

  async execute(
    node: WorkflowNode,
    context: NodeExecutionContext,
  ): Promise<NodeHandlerResult> {
    this.assertType(node, this.type);
    const text = renderReplyTemplate(node.config.text, context);
    const idempotencyKey = `${context.executionId}:${node.id}`;
    const claimed = await this.repository.claimDelivery({
      executionId: context.executionId,
      nodeId: node.id,
      idempotencyKey,
      providerChatId: context.envelope.chat.providerChatId,
      replyToProviderMessageId: node.config.replyToSourceMessage
        ? context.envelope.message.providerMessageId
        : null,
      bodyHash: sha256(text),
    });

    if (claimed.delivery.status === "confirmed") {
      return {
        status: "succeeded",
        nextNodeId: node.onSuccess,
        outputSummary: {
          deliveryId: claimed.delivery.id,
          deliveryStatus: "confirmed",
          deduplicated: true,
        },
      };
    }
    if (
      !claimed.created &&
      ["pending", "sending", "unknown"].includes(claimed.delivery.status)
    ) {
      throw new WorkflowExecutionError(
        "REPLY_RESULT_UNKNOWN",
        "The reply may already have been sent and requires manual confirmation.",
        false,
        true,
      );
    }
    if (
      claimed.delivery.status === "failed" &&
      claimed.delivery.retryable === false
    ) {
      throw new WorkflowExecutionError(
        claimed.delivery.errorCode ?? "REPLY_REJECTED",
        claimed.delivery.errorSummary ?? "The reply was rejected.",
        false,
      );
    }

    await this.repository.markDeliverySending(claimed.delivery.id);
    const result = await this.gateway.sendReply({
      providerChatId: context.envelope.chat.providerChatId,
      text,
      replyToProviderMessageId: node.config.replyToSourceMessage
        ? context.envelope.message.providerMessageId
        : null,
      idempotencyKey,
      providerTempGuid: claimed.delivery.providerTempGuid,
      correlationId: context.correlationId,
    });

    if (result.status === "confirmed") {
      await this.repository.confirmDelivery(
        claimed.delivery.id,
        result.providerMessageId,
      );
      return {
        status: "succeeded",
        nextNodeId: node.onSuccess,
        outputSummary: {
          deliveryId: claimed.delivery.id,
          deliveryStatus: "confirmed",
        },
      };
    }
    if (result.status === "unknown") {
      await this.repository.failDelivery(claimed.delivery.id, "unknown", {
        code: result.code,
        summary: result.summary,
        retryable: false,
      });
      throw new WorkflowExecutionError(
        result.code,
        result.summary,
        false,
        true,
      );
    }

    await this.repository.failDelivery(claimed.delivery.id, "failed", result);
    throw new WorkflowExecutionError(
      result.code,
      result.summary,
      result.retryable,
    );
  }
}

class EndNodeHandler extends BaseNodeHandler {
  readonly type = "end" as const;

  execute(node: WorkflowNode): Promise<NodeHandlerResult> {
    this.assertType(node, this.type);
    return Promise.resolve({
      status: node.config.result,
      nextNodeId: null,
      completionStatus: node.config.result,
      outputSummary: { result: node.config.result },
    });
  }
}

export class NodeRegistry {
  private readonly handlers = new Map<string, NodeHandler>();

  register(handler: NodeHandler): void {
    const key = this.key(handler.type, handler.version);
    if (this.handlers.has(key)) {
      throw new Error(`Node handler '${key}' is already registered.`);
    }
    this.handlers.set(key, handler);
  }

  resolve(node: WorkflowNode): NodeHandler {
    const handler = this.handlers.get(this.key(node.type, node.version));
    if (handler === undefined) {
      throw new WorkflowExecutionError(
        "UNKNOWN_NODE_TYPE",
        `No handler is registered for '${node.type}@${node.version}'.`,
        false,
      );
    }
    return handler;
  }

  private key(type: string, version: number): string {
    return `${type}@${version}`;
  }
}

export function createDefaultNodeRegistry(
  repository: WorkflowRepository,
  gateway: ReplyGateway,
  capabilities?: {
    archive: ArchiveRepository;
    aiRouting: AiRoutingService;
  },
): NodeRegistry {
  const registry = new NodeRegistry();
  registry.register(new ConditionNodeHandler());
  registry.register(new LogNodeHandler());
  registry.register(new SetVariableNodeHandler());
  if (capabilities !== undefined) {
    registry.register(new LoadContextNodeHandler(capabilities.archive));
    registry.register(new AiChatNodeHandler(capabilities.aiRouting));
  }
  registry.register(new ReplyNodeHandler(repository, gateway));
  registry.register(new EndNodeHandler());
  return registry;
}
