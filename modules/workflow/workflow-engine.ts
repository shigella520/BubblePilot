import type { MessageEnvelope } from "../ingestion/message-envelope.js";
import type { ContextMessage } from "../archive/archive-repository.js";
import {
  BoundedExecutionGate,
  type WorkflowGateStatus,
} from "./execution-gate.js";
import { matchTrigger } from "./trigger-matcher.js";
import type {
  NodeHandler,
  NodeRegistry,
  NodeRetryPolicy,
} from "./node-registry.js";
import { WorkflowExecutionError } from "./workflow-errors.js";
import type {
  ExecutionCloseResult,
  ExecutionRecoveryClaim,
  TriggerBinding,
  WorkflowExecutionRecord,
  WorkflowRepository,
} from "./workflow-repository.js";

export interface AutomationResult {
  executionIds: readonly string[];
  matchedTriggerIds: readonly string[];
  activeTriggerCount: number;
}

export interface MessageAutomation {
  handleMessage(envelope: MessageEnvelope): Promise<AutomationResult>;
  retryExecution(
    executionId: string,
    correlationId: string,
    staleRetryBefore: Date,
  ): Promise<ExecutionRecoveryClaim>;
  closeExecution(executionId: string): Promise<ExecutionCloseResult>;
  runtimeStatus(): WorkflowGateStatus;
}

function safeError(error: unknown): WorkflowExecutionError {
  return error instanceof WorkflowExecutionError
    ? error
    : new WorkflowExecutionError(
        "NODE_EXECUTION_FAILED",
        "The workflow node failed unexpectedly.",
        false,
        false,
        { cause: error },
      );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class WorkflowEngine implements MessageAutomation {
  private readonly gate: BoundedExecutionGate;

  constructor(
    private readonly repository: WorkflowRepository,
    private readonly registry: NodeRegistry,
    options: {
      maxConcurrency?: number;
      queueCapacity?: number;
      queueWaitMs?: number;
    } = {},
  ) {
    this.gate = new BoundedExecutionGate(
      options.maxConcurrency ?? 4,
      options.queueCapacity ?? 64,
      options.queueWaitMs ?? 30_000,
    );
  }

  async handleMessage(envelope: MessageEnvelope): Promise<AutomationResult> {
    const bindings = await this.repository.listActiveTriggerBindings();
    const matched = bindings.filter(
      (binding) =>
        matchTrigger(envelope, binding.conditions, binding.includeFromMe)
          .matched,
    );
    const executionIds: string[] = [];

    for (const trigger of matched) {
      const executionId = await this.gate.run(async () => {
        const claimed = await this.repository.createExecution({
          envelope,
          trigger,
        });
        if (claimed.created) {
          await this.run(claimed.execution, trigger, envelope);
        }
        return claimed.execution.id;
      });
      executionIds.push(executionId);
    }

    return {
      executionIds,
      matchedTriggerIds: matched.map((trigger) => trigger.id),
      activeTriggerCount: bindings.length,
    };
  }

  async retryExecution(
    executionId: string,
    correlationId: string,
    staleRetryBefore: Date,
  ): Promise<ExecutionRecoveryClaim> {
    return this.gate.run(async () => {
      const claim = await this.repository.createManualRetry(
        executionId,
        correlationId,
        staleRetryBefore,
      );
      if (claim.status !== "created") {
        return claim;
      }
      await this.run(claim.execution, claim.trigger, claim.envelope);
      return claim;
    });
  }

  closeExecution(executionId: string): Promise<ExecutionCloseResult> {
    return this.repository.closeExecution(executionId);
  }

  runtimeStatus(): WorkflowGateStatus {
    return this.gate.status();
  }

  private async run(
    execution: WorkflowExecutionRecord,
    trigger: TriggerBinding,
    envelope: MessageEnvelope,
  ): Promise<void> {
    const definition = trigger.definition;
    const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
    const deadline = Date.now() + definition.maxExecutionMs;
    const variables: Record<string, string> = {};
    const history: ContextMessage[] = [];
    const outputs: Record<string, Record<string, unknown>> = {};
    let currentNodeId: string | null = definition.startNodeId;
    let steps = 0;

    while (currentNodeId !== null) {
      steps += 1;
      if (steps > definition.maxSteps || Date.now() >= deadline) {
        await this.repository.finishExecution(execution.id, "dead-lettered", {
          code: "WORKFLOW_BUDGET_EXHAUSTED",
          summary: "The workflow exceeded its configured execution budget.",
        });
        return;
      }
      const node = nodes.get(currentNodeId);
      if (node === undefined) {
        await this.repository.finishExecution(execution.id, "failed", {
          code: "WORKFLOW_NODE_MISSING",
          summary: "The locked workflow references a missing node.",
        });
        return;
      }

      await this.repository.markExecutionRunning(execution.id, node.id);
      let handler: NodeHandler;
      let retry: NodeRetryPolicy;
      try {
        handler = this.registry.resolve(node);
        retry = handler.retryPolicy(node);
      } catch (error) {
        const workflowError = safeError(error);
        await this.repository.finishExecution(
          execution.id,
          workflowError.retryable || workflowError.requiresManualRecovery
            ? "dead-lettered"
            : "failed",
          { code: workflowError.code, summary: workflowError.message },
        );
        return;
      }
      let finalError: WorkflowExecutionError | null = null;

      for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
        const nodeExecutionId = await this.repository.startNodeExecution({
          executionId: execution.id,
          node,
          attempt,
          inputSummary: {
            eventId: envelope.eventId,
            contentType: envelope.message.contentType,
            hasText: envelope.message.text !== null,
            attachmentCount: envelope.message.attachments.length,
            variableCount: Object.keys(variables).length,
            historyMessageCount: history.length,
          },
        });

        try {
          const result = await handler.execute(node, {
            executionId: execution.id,
            correlationId: execution.correlationId,
            envelope,
            deadlineAt: deadline,
            variables,
            history,
            outputs,
          });
          await this.repository.finishNodeExecution({
            nodeExecutionId,
            status: result.status,
            outputSummary: result.outputSummary,
          });
          outputs[node.id] = { ...result.outputSummary };
          if (result.completionStatus !== undefined) {
            await this.repository.finishExecution(
              execution.id,
              result.completionStatus,
            );
            return;
          }
          currentNodeId = result.nextNodeId;
          finalError = null;
          break;
        } catch (error) {
          const workflowError = safeError(error);
          finalError = workflowError;
          await this.repository.finishNodeExecution({
            nodeExecutionId,
            status: "failed",
            error: {
              code: workflowError.code,
              summary: workflowError.message,
              retryable: workflowError.retryable,
            },
          });

          if (!workflowError.retryable || attempt >= retry.maxAttempts) {
            break;
          }
          const waitMs = retry.initialDelayMs * 2 ** (attempt - 1);
          const nextRetryAt = new Date(Date.now() + waitMs);
          if (nextRetryAt.getTime() >= deadline) {
            break;
          }
          await this.repository.markExecutionRetrying(
            execution.id,
            node.id,
            nextRetryAt,
            workflowError.code,
          );
          await delay(waitMs);
          const resumed = await this.repository.resumeExecutionRetry(
            execution.id,
            node.id,
            nextRetryAt,
          );
          if (!resumed) return;
        }
      }

      if (finalError !== null) {
        const failureTarget = handler.failureTarget(node);
        if (failureTarget !== null && !finalError.requiresManualRecovery) {
          currentNodeId = failureTarget;
          continue;
        }
        await this.repository.finishExecution(
          execution.id,
          finalError.retryable || finalError.requiresManualRecovery
            ? "dead-lettered"
            : "failed",
          { code: finalError.code, summary: finalError.message },
        );
        return;
      }
    }

    await this.repository.finishExecution(execution.id, "failed", {
      code: "WORKFLOW_ENDED_WITHOUT_END_NODE",
      summary: "The workflow ended without an explicit end node.",
    });
  }
}
