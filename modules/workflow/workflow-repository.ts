import type { MessageEnvelope } from "../ingestion/message-envelope.js";
import type { ConversationSummaryTrigger } from "./conversation-context-service.js";
import type { TriggerConditions } from "./trigger-matcher.js";
import type {
  WorkflowDefinition,
  WorkflowNode,
} from "./workflow-definition.js";

export type WorkflowVersionStatus =
  "draft" | "validated" | "published" | "superseded" | "invalid";

export type WorkflowExecutionStatus =
  | "created"
  | "running"
  | "retrying"
  | "succeeded"
  | "skipped"
  | "failed"
  | "dead-lettered"
  | "closed";

export interface WorkflowVersionRecord {
  id: string;
  workflowId: string;
  workflowName: string;
  version: number;
  status: WorkflowVersionStatus;
  definition: WorkflowDefinition;
  createdAt: string;
  publishedAt: string | null;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  status: "draft" | "active" | "inactive";
  publishedVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerRecord {
  id: string;
  name: string;
  workflowId: string;
  workflowVersionId: string;
  workflowVersion: number;
  conditions: TriggerConditions;
  includeFromMe: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerBinding extends TriggerRecord {
  definition: WorkflowDefinition;
}

export interface WorkflowExecutionRecord {
  id: string;
  provider: string;
  externalEventId: string;
  providerChatId: string | null;
  chatDisplayName: string | null;
  triggerId: string;
  triggerName: string;
  workflowId: string;
  workflowName: string;
  workflowVersionId: string;
  workflowVersion: number;
  retryOfExecutionId: string | null;
  recoveryAttempt: number;
  correlationId: string;
  status: WorkflowExecutionStatus;
  currentNodeId: string | null;
  errorCode: string | null;
  errorSummary: string | null;
  nextRetryAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  cachedPromptTokens: number | null;
  cacheEligiblePromptTokens: number;
  cacheHitRate: number | null;
  contextSnapshot: Readonly<Record<string, unknown>> | null;
}

export interface MessageExecutionLink {
  providerMessageId: string;
  execution: WorkflowExecutionRecord;
}

export interface NodeExecutionRecord {
  id: string;
  nodeId: string;
  nodeType: string;
  nodeVersion: number;
  attempt: number;
  status: "running" | "succeeded" | "skipped" | "failed";
  inputSummary: Readonly<Record<string, unknown>>;
  outputSummary: Readonly<Record<string, unknown>>;
  errorCode: string | null;
  errorSummary: string | null;
  retryable: boolean | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export type OutboundDeliveryStatus =
  "pending" | "sending" | "confirmed" | "failed" | "unknown";

export interface OutboundDeliveryRecord {
  id: string;
  executionId: string;
  nodeId: string;
  idempotencyKey: string;
  providerChatId: string;
  replyToProviderMessageId: string | null;
  providerTempGuid: string;
  providerMessageId: string | null;
  status: OutboundDeliveryStatus;
  attemptCount: number;
  errorCode: string | null;
  errorSummary: string | null;
  retryable: boolean | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
}

export interface ExecutionDetail extends WorkflowExecutionRecord {
  nodes: readonly NodeExecutionRecord[];
  deliveries: readonly OutboundDeliveryRecord[];
}

export interface WorkflowRuntimeSummary {
  executions: {
    created: number;
    running: number;
    retrying: number;
    failed: number;
    deadLettered: number;
    closed: number;
    staleRetrying: number;
  };
  outbound: {
    sending: number;
    unknown: number;
  };
  oldestDeadLetterAt: string | null;
}

export type ExecutionRecoveryConflictReason =
  | "execution-not-recoverable"
  | "execution-retry-still-active"
  | "recovery-already-created"
  | "source-message-unavailable"
  | "outbound-result-unknown"
  | "outbound-already-confirmed";

export type ExecutionRecoveryClaim =
  | {
      status: "created";
      execution: WorkflowExecutionRecord;
      trigger: TriggerBinding;
      envelope: MessageEnvelope;
    }
  | { status: "not-found" }
  | { status: "conflict"; reason: ExecutionRecoveryConflictReason };

export type ExecutionCloseResult =
  | { status: "ok"; execution: WorkflowExecutionRecord }
  | { status: "not-found" }
  | { status: "conflict"; reason: "execution-not-closeable" };

export interface WorkflowRepository {
  createWorkflow(
    name: string,
    definition: WorkflowDefinition,
  ): Promise<WorkflowVersionRecord>;
  createWorkflowVersion(
    workflowId: string,
    definition: WorkflowDefinition,
    name?: string,
  ): Promise<WorkflowVersionRecord | null>;
  getWorkflowVersion(
    workflowId: string,
    version: number,
  ): Promise<WorkflowVersionRecord | null>;
  listWorkflowVersions(
    workflowId: string,
  ): Promise<readonly WorkflowVersionRecord[]>;
  publishWorkflowVersion(
    workflowId: string,
    version: number,
  ): Promise<WorkflowVersionRecord | null>;
  setWorkflowEnabled(
    workflowId: string,
    enabled: boolean,
  ): Promise<WorkflowRecord | null>;
  deleteWorkflow(
    workflowId: string,
  ): Promise<"deleted" | "not-found" | "referenced">;
  listWorkflows(): Promise<readonly WorkflowRecord[]>;
  createTrigger(input: {
    name: string;
    workflowId: string;
    workflowVersion: number;
    conditions: TriggerConditions;
    includeFromMe: boolean;
    enabled: boolean;
  }): Promise<TriggerRecord | null>;
  updateTriggerEnabled(
    triggerId: string,
    enabled: boolean,
  ): Promise<TriggerRecord | null>;
  updateTrigger(
    triggerId: string,
    input: {
      name: string;
      conditions: TriggerConditions;
      includeFromMe: boolean;
    },
  ): Promise<TriggerRecord | null>;
  deleteTrigger(
    triggerId: string,
  ): Promise<"deleted" | "not-found" | "referenced">;
  listTriggers(): Promise<readonly TriggerRecord[]>;
  listActiveTriggerBindings(): Promise<readonly TriggerBinding[]>;
  createExecution(input: {
    envelope: MessageEnvelope;
    trigger: TriggerBinding;
    summaryTrigger?: ConversationSummaryTrigger;
  }): Promise<{ execution: WorkflowExecutionRecord; created: boolean }>;
  createManualRetry(
    executionId: string,
    correlationId: string,
    staleRetryBefore: Date,
  ): Promise<ExecutionRecoveryClaim>;
  closeExecution(executionId: string): Promise<ExecutionCloseResult>;
  markExecutionRunning(executionId: string, nodeId: string): Promise<void>;
  recordContextSnapshot?(
    executionId: string,
    snapshot: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  markExecutionRetrying(
    executionId: string,
    nodeId: string,
    nextRetryAt: Date,
    errorCode: string,
  ): Promise<void>;
  resumeExecutionRetry(
    executionId: string,
    nodeId: string,
    expectedNextRetryAt: Date,
  ): Promise<boolean>;
  finishExecution(
    executionId: string,
    status: "succeeded" | "skipped" | "failed" | "dead-lettered",
    error?: { code: string; summary: string },
  ): Promise<void>;
  startNodeExecution(input: {
    executionId: string;
    node: WorkflowNode;
    attempt: number;
    inputSummary: Readonly<Record<string, unknown>>;
  }): Promise<string>;
  finishNodeExecution(input: {
    nodeExecutionId: string;
    status: "succeeded" | "skipped" | "failed";
    outputSummary?: Readonly<Record<string, unknown>>;
    error?: { code: string; summary: string; retryable: boolean };
  }): Promise<void>;
  claimDelivery(input: {
    executionId: string;
    nodeId: string;
    idempotencyKey: string;
    providerChatId: string;
    replyToProviderMessageId: string | null;
    bodyHash: string;
  }): Promise<{ delivery: OutboundDeliveryRecord; created: boolean }>;
  markDeliverySending(deliveryId: string): Promise<void>;
  confirmDelivery(
    deliveryId: string,
    providerMessageId: string | null,
  ): Promise<void>;
  failDelivery(
    deliveryId: string,
    status: "failed" | "unknown",
    error: { code: string; summary: string; retryable: boolean },
  ): Promise<void>;
  listExecutions(options: {
    limit: number;
    statuses?: readonly WorkflowExecutionStatus[];
    cursor: { timestamp: Date; id: string } | null;
  }): Promise<readonly WorkflowExecutionRecord[]>;
  listExecutionsForMessages(
    providerMessageIds: readonly string[],
  ): Promise<readonly MessageExecutionLink[]>;
  getExecution(executionId: string): Promise<ExecutionDetail | null>;
  getRuntimeSummary(staleRetryBefore: Date): Promise<WorkflowRuntimeSummary>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
