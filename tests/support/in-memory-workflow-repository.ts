import { randomUUID } from "node:crypto";

import type { MessageEnvelope } from "../../modules/ingestion/message-envelope.js";
import type { TriggerConditions } from "../../modules/workflow/trigger-matcher.js";
import type {
  WorkflowDefinition,
  WorkflowNode,
} from "../../modules/workflow/workflow-definition.js";
import type {
  ExecutionDetail,
  ExecutionCloseResult,
  ExecutionRecoveryClaim,
  MessageExecutionLink,
  NodeExecutionRecord,
  OutboundDeliveryRecord,
  TriggerBinding,
  TriggerRecord,
  WorkflowExecutionRecord,
  WorkflowRecord,
  WorkflowRepository,
  WorkflowExecutionStatus,
  WorkflowRuntimeSummary,
  WorkflowVersionRecord,
} from "../../modules/workflow/workflow-repository.js";

interface StoredWorkflow extends WorkflowRecord {
  versions: WorkflowVersionRecord[];
}

interface StoredExecution extends WorkflowExecutionRecord {
  sourceProviderMessageId: string;
  sourceEnvelope: MessageEnvelope;
  nodes: NodeExecutionRecord[];
  deliveries: OutboundDeliveryRecord[];
}

export class InMemoryWorkflowRepository implements WorkflowRepository {
  readonly workflows = new Map<string, StoredWorkflow>();
  readonly deletedWorkflowIds = new Set<string>();
  readonly triggers = new Map<string, TriggerRecord>();
  readonly deletedTriggerIds = new Set<string>();
  readonly executions = new Map<string, StoredExecution>();
  readonly deliveries = new Map<string, OutboundDeliveryRecord>();

  async createWorkflow(
    name: string,
    definition: WorkflowDefinition,
  ): Promise<WorkflowVersionRecord> {
    const now = new Date().toISOString();
    const workflowId = randomUUID();
    const version: WorkflowVersionRecord = {
      id: randomUUID(),
      workflowId,
      workflowName: name,
      version: 1,
      status: "validated",
      definition,
      createdAt: now,
      publishedAt: null,
    };
    this.workflows.set(workflowId, {
      id: workflowId,
      name,
      status: "draft",
      publishedVersion: null,
      createdAt: now,
      updatedAt: now,
      versions: [version],
    });
    return version;
  }

  async createWorkflowVersion(
    workflowId: string,
    definition: WorkflowDefinition,
    name?: string,
  ): Promise<WorkflowVersionRecord | null> {
    const workflow = this.workflows.get(workflowId);
    if (workflow === undefined || this.deletedWorkflowIds.has(workflowId)) {
      return null;
    }
    if (name !== undefined) {
      workflow.name = name;
      workflow.updatedAt = new Date().toISOString();
      for (const existingVersion of workflow.versions) {
        existingVersion.workflowName = name;
      }
    }
    const version: WorkflowVersionRecord = {
      id: randomUUID(),
      workflowId,
      workflowName: workflow.name,
      version: workflow.versions.length + 1,
      status: "validated",
      definition,
      createdAt: new Date().toISOString(),
      publishedAt: null,
    };
    workflow.versions.push(version);
    return version;
  }

  async publishWorkflowVersion(
    workflowId: string,
    versionNumber: number,
  ): Promise<WorkflowVersionRecord | null> {
    const workflow = this.workflows.get(workflowId);
    if (this.deletedWorkflowIds.has(workflowId)) return null;
    const version = workflow?.versions.find(
      (candidate) => candidate.version === versionNumber,
    );
    if (
      workflow === undefined ||
      version === undefined ||
      !["validated", "published"].includes(version.status)
    ) {
      return null;
    }
    for (const candidate of workflow.versions) {
      if (candidate.status === "published" && candidate.id !== version.id) {
        candidate.status = "superseded";
        for (const trigger of this.triggers.values()) {
          if (trigger.workflowVersionId === candidate.id) {
            trigger.workflowVersionId = version.id;
            trigger.workflowVersion = version.version;
            trigger.updatedAt = new Date().toISOString();
          }
        }
      }
    }
    version.status = "published";
    version.publishedAt ??= new Date().toISOString();
    workflow.status = "active";
    workflow.publishedVersion = version.version;
    workflow.updatedAt = new Date().toISOString();
    return version;
  }

  setWorkflowEnabled(
    workflowId: string,
    enabled: boolean,
  ): Promise<WorkflowRecord | null> {
    const workflow = this.workflows.get(workflowId);
    if (this.deletedWorkflowIds.has(workflowId)) return Promise.resolve(null);
    if (workflow === undefined || workflow.publishedVersion === null) {
      return Promise.resolve(null);
    }
    workflow.status = enabled ? "active" : "inactive";
    workflow.updatedAt = new Date().toISOString();
    return Promise.resolve(structuredClone(workflow));
  }

  async deleteWorkflow(
    workflowId: string,
  ): Promise<"deleted" | "not-found" | "referenced"> {
    const workflow = this.workflows.get(workflowId);
    if (workflow === undefined || this.deletedWorkflowIds.has(workflowId))
      return "not-found";
    const versionIds = new Set(workflow.versions.map((version) => version.id));
    this.deletedWorkflowIds.add(workflowId);
    workflow.status = "inactive";
    workflow.publishedVersion = null;
    for (const trigger of this.triggers.values()) {
      if (versionIds.has(trigger.workflowVersionId))
        this.deletedTriggerIds.add(trigger.id);
    }
    return "deleted";
  }

  getWorkflowVersion(
    workflowId: string,
    versionNumber: number,
  ): Promise<WorkflowVersionRecord | null> {
    const version = this.workflows
      .get(workflowId)
      ?.versions.find((candidate) => candidate.version === versionNumber);
    if (this.deletedWorkflowIds.has(workflowId)) return Promise.resolve(null);
    return Promise.resolve(
      version === undefined ? null : structuredClone(version),
    );
  }

  listWorkflowVersions(
    workflowId: string,
  ): Promise<readonly WorkflowVersionRecord[]> {
    if (this.deletedWorkflowIds.has(workflowId)) return Promise.resolve([]);
    const versions = this.workflows.get(workflowId)?.versions ?? [];
    return Promise.resolve(
      structuredClone(
        [...versions].sort((left, right) => right.version - left.version),
      ),
    );
  }

  listWorkflows(): Promise<readonly WorkflowRecord[]> {
    return Promise.resolve(
      [...this.workflows.values()]
        .filter((workflow) => !this.deletedWorkflowIds.has(workflow.id))
        .map((workflow) => ({
          id: workflow.id,
          name: workflow.name,
          status: workflow.status,
          publishedVersion: workflow.publishedVersion,
          createdAt: workflow.createdAt,
          updatedAt: workflow.updatedAt,
        })),
    );
  }

  async createTrigger(input: {
    name: string;
    workflowId: string;
    workflowVersion: number;
    conditions: TriggerConditions;
    includeFromMe: boolean;
    enabled: boolean;
  }): Promise<TriggerRecord | null> {
    const workflow = this.workflows.get(input.workflowId);
    const version = workflow?.versions.find(
      (candidate) =>
        candidate.version === input.workflowVersion &&
        candidate.status === "published",
    );
    if (workflow?.status !== "active" || version === undefined) {
      return null;
    }
    const now = new Date().toISOString();
    const trigger: TriggerRecord = {
      id: randomUUID(),
      name: input.name,
      workflowId: input.workflowId,
      workflowVersionId: version.id,
      workflowVersion: version.version,
      conditions: input.conditions,
      includeFromMe: input.includeFromMe,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
    };
    this.triggers.set(trigger.id, trigger);
    return trigger;
  }

  async updateTriggerEnabled(
    triggerId: string,
    enabled: boolean,
  ): Promise<TriggerRecord | null> {
    const trigger = this.triggers.get(triggerId);
    if (trigger === undefined || this.deletedTriggerIds.has(triggerId)) {
      return null;
    }
    const workflow = this.workflows.get(trigger.workflowId);
    const version = workflow?.versions.find(
      (candidate) => candidate.id === trigger.workflowVersionId,
    );
    if (
      enabled &&
      (workflow?.status !== "active" || version?.status !== "published")
    ) {
      return null;
    }
    trigger.enabled = enabled;
    trigger.updatedAt = new Date().toISOString();
    return trigger;
  }

  async updateTrigger(
    triggerId: string,
    input: {
      name: string;
      conditions: TriggerConditions;
      includeFromMe: boolean;
    },
  ): Promise<TriggerRecord | null> {
    const trigger = this.triggers.get(triggerId);
    if (trigger === undefined || this.deletedTriggerIds.has(triggerId))
      return null;
    trigger.name = input.name;
    trigger.conditions = input.conditions;
    trigger.includeFromMe = input.includeFromMe;
    trigger.updatedAt = new Date().toISOString();
    return trigger;
  }

  async deleteTrigger(
    triggerId: string,
  ): Promise<"deleted" | "not-found" | "referenced"> {
    if (!this.triggers.has(triggerId) || this.deletedTriggerIds.has(triggerId))
      return "not-found";
    this.deletedTriggerIds.add(triggerId);
    const trigger = this.triggers.get(triggerId);
    if (trigger) {
      trigger.enabled = false;
      trigger.updatedAt = new Date().toISOString();
    }
    return "deleted";
  }

  listTriggers(): Promise<readonly TriggerRecord[]> {
    return Promise.resolve(
      [...this.triggers.values()]
        .filter((trigger) => !this.deletedTriggerIds.has(trigger.id))
        .map((trigger) => structuredClone(trigger)),
    );
  }

  listActiveTriggerBindings(): Promise<readonly TriggerBinding[]> {
    const bindings: TriggerBinding[] = [];
    for (const trigger of this.triggers.values()) {
      if (this.deletedTriggerIds.has(trigger.id)) continue;
      const workflow = this.workflows.get(trigger.workflowId);
      const version = workflow?.versions.find(
        (candidate) => candidate.id === trigger.workflowVersionId,
      );
      if (
        trigger.enabled &&
        workflow?.status === "active" &&
        version?.status === "published"
      ) {
        bindings.push({
          ...structuredClone(trigger),
          definition: version.definition,
        });
      }
    }
    return Promise.resolve(bindings);
  }

  async createExecution(input: {
    envelope: MessageEnvelope;
    trigger: TriggerBinding;
  }): Promise<{ execution: WorkflowExecutionRecord; created: boolean }> {
    const existing = [...this.executions.values()].find(
      (execution) =>
        execution.provider === input.envelope.provider &&
        execution.externalEventId === input.envelope.eventId &&
        execution.triggerId === input.trigger.id &&
        execution.workflowVersionId === input.trigger.workflowVersionId,
    );
    if (existing !== undefined) {
      return { execution: this.executionRecord(existing), created: false };
    }
    const execution: StoredExecution = {
      id: randomUUID(),
      provider: input.envelope.provider,
      externalEventId: input.envelope.eventId,
      providerChatId: input.envelope.chat.providerChatId,
      chatDisplayName: input.envelope.chat.displayName,
      triggerId: input.trigger.id,
      triggerName: input.trigger.name,
      workflowId: input.trigger.workflowId,
      workflowName:
        this.workflows.get(input.trigger.workflowId)?.name ?? "unknown",
      workflowVersionId: input.trigger.workflowVersionId,
      workflowVersion: input.trigger.workflowVersion,
      retryOfExecutionId: null,
      recoveryAttempt: 0,
      correlationId: input.envelope.correlationId,
      status: "created",
      currentNodeId: null,
      errorCode: null,
      errorSummary: null,
      nextRetryAt: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date().toISOString(),
      cachedPromptTokens: null,
      cacheEligiblePromptTokens: 0,
      cacheHitRate: null,
      summaryCompressionStatus: "none",
      sourceProviderMessageId: input.envelope.message.providerMessageId,
      sourceEnvelope: structuredClone(input.envelope),
      nodes: [],
      deliveries: [],
    };
    this.executions.set(execution.id, execution);
    return { execution: this.executionRecord(execution), created: true };
  }

  createManualRetry(
    executionId: string,
    correlationId: string,
    staleRetryBefore: Date,
  ): Promise<ExecutionRecoveryClaim> {
    const source = this.executions.get(executionId);
    if (source === undefined) {
      return Promise.resolve({ status: "not-found" });
    }
    const staleRetry =
      source.status === "retrying" &&
      source.nextRetryAt !== null &&
      Date.parse(source.nextRetryAt) <= staleRetryBefore.getTime();
    if (source.status === "retrying" && !staleRetry) {
      return Promise.resolve({
        status: "conflict",
        reason: "execution-retry-still-active",
      });
    }
    if (
      source.status !== "failed" &&
      source.status !== "dead-lettered" &&
      !staleRetry
    ) {
      return Promise.resolve({
        status: "conflict",
        reason: "execution-not-recoverable",
      });
    }
    if (
      [...this.executions.values()].some(
        (execution) => execution.retryOfExecutionId === source.id,
      )
    ) {
      return Promise.resolve({
        status: "conflict",
        reason: "recovery-already-created",
      });
    }
    if (
      source.deliveries.some((delivery) =>
        ["sending", "unknown"].includes(delivery.status),
      )
    ) {
      return Promise.resolve({
        status: "conflict",
        reason: "outbound-result-unknown",
      });
    }
    if (source.deliveries.some((delivery) => delivery.status === "confirmed")) {
      return Promise.resolve({
        status: "conflict",
        reason: "outbound-already-confirmed",
      });
    }
    const trigger = this.triggers.get(source.triggerId);
    const workflow = this.workflows.get(source.workflowId);
    const version = workflow?.versions.find(
      (candidate) => candidate.id === source.workflowVersionId,
    );
    if (
      trigger === undefined ||
      workflow === undefined ||
      version === undefined
    ) {
      return Promise.resolve({
        status: "conflict",
        reason: "source-message-unavailable",
      });
    }
    if (staleRetry) {
      source.status = "failed";
      source.currentNodeId = null;
      source.nextRetryAt = null;
      source.errorCode = "STALE_RETRY_RECOVERED";
      source.errorSummary =
        "The expired retry was superseded by a manual recovery execution.";
      source.completedAt = new Date().toISOString();
    }
    const now = new Date().toISOString();
    const recovery: StoredExecution = {
      id: randomUUID(),
      provider: source.provider,
      externalEventId: `${source.externalEventId}:manual-retry:${randomUUID()}`,
      providerChatId: source.providerChatId,
      chatDisplayName: source.chatDisplayName,
      triggerId: source.triggerId,
      triggerName: source.triggerName,
      workflowId: source.workflowId,
      workflowName: source.workflowName,
      workflowVersionId: source.workflowVersionId,
      workflowVersion: source.workflowVersion,
      retryOfExecutionId: source.id,
      recoveryAttempt: source.recoveryAttempt + 1,
      correlationId,
      status: "created",
      currentNodeId: null,
      errorCode: null,
      errorSummary: null,
      nextRetryAt: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      cachedPromptTokens: null,
      cacheEligiblePromptTokens: 0,
      cacheHitRate: null,
      summaryCompressionStatus: "none",
      sourceProviderMessageId: source.sourceProviderMessageId,
      sourceEnvelope: {
        ...structuredClone(source.sourceEnvelope),
        correlationId,
        metadata: {
          ...source.sourceEnvelope.metadata,
          isReplay: true,
        },
      },
      nodes: [],
      deliveries: [],
    };
    this.executions.set(recovery.id, recovery);
    return Promise.resolve({
      status: "created",
      execution: this.executionRecord(recovery),
      trigger: {
        ...structuredClone(trigger),
        definition: structuredClone(version.definition),
      },
      envelope: structuredClone(recovery.sourceEnvelope),
    });
  }

  closeExecution(executionId: string): Promise<ExecutionCloseResult> {
    const execution = this.executions.get(executionId);
    if (execution === undefined) {
      return Promise.resolve({ status: "not-found" });
    }
    if (
      execution.status !== "failed" &&
      execution.status !== "dead-lettered" &&
      execution.status !== "retrying"
    ) {
      return Promise.resolve({
        status: "conflict",
        reason: "execution-not-closeable",
      });
    }
    execution.status = "closed";
    execution.currentNodeId = null;
    execution.nextRetryAt = null;
    execution.completedAt ??= new Date().toISOString();
    return Promise.resolve({
      status: "ok",
      execution: this.executionRecord(execution),
    });
  }

  async markExecutionRunning(
    executionId: string,
    nodeId: string,
  ): Promise<void> {
    const execution = this.requiredExecution(executionId);
    execution.status = "running";
    execution.currentNodeId = nodeId;
    execution.startedAt ??= new Date().toISOString();
    execution.nextRetryAt = null;
  }

  async markExecutionRetrying(
    executionId: string,
    nodeId: string,
    nextRetryAt: Date,
    errorCode: string,
  ): Promise<void> {
    const execution = this.requiredExecution(executionId);
    execution.status = "retrying";
    execution.currentNodeId = nodeId;
    execution.nextRetryAt = nextRetryAt.toISOString();
    execution.errorCode = errorCode;
  }

  resumeExecutionRetry(
    executionId: string,
    nodeId: string,
    expectedNextRetryAt: Date,
  ): Promise<boolean> {
    const execution = this.requiredExecution(executionId);
    if (
      execution.status !== "retrying" ||
      execution.currentNodeId !== nodeId ||
      execution.nextRetryAt !== expectedNextRetryAt.toISOString()
    ) {
      return Promise.resolve(false);
    }
    execution.status = "running";
    execution.startedAt ??= new Date().toISOString();
    execution.nextRetryAt = null;
    return Promise.resolve(true);
  }

  async finishExecution(
    executionId: string,
    status: "succeeded" | "skipped" | "failed" | "dead-lettered",
    error?: { code: string; summary: string },
  ): Promise<void> {
    const execution = this.requiredExecution(executionId);
    execution.status = status;
    execution.currentNodeId = null;
    execution.nextRetryAt = null;
    execution.errorCode = error?.code ?? null;
    execution.errorSummary = error?.summary ?? null;
    execution.completedAt = new Date().toISOString();
  }

  async startNodeExecution(input: {
    executionId: string;
    node: WorkflowNode;
    attempt: number;
    inputSummary: Readonly<Record<string, unknown>>;
  }): Promise<string> {
    const record: NodeExecutionRecord = {
      id: randomUUID(),
      nodeId: input.node.id,
      nodeType: input.node.type,
      nodeVersion: input.node.version,
      attempt: input.attempt,
      status: "running",
      inputSummary: input.inputSummary,
      outputSummary: {},
      errorCode: null,
      errorSummary: null,
      retryable: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      durationMs: null,
    };
    this.requiredExecution(input.executionId).nodes.push(record);
    return record.id;
  }

  async finishNodeExecution(input: {
    nodeExecutionId: string;
    status: "succeeded" | "skipped" | "failed";
    outputSummary?: Readonly<Record<string, unknown>>;
    error?: { code: string; summary: string; retryable: boolean };
  }): Promise<void> {
    const record = [...this.executions.values()]
      .flatMap((execution) => execution.nodes)
      .find((node) => node.id === input.nodeExecutionId);
    if (record === undefined) {
      throw new Error("Node execution not found.");
    }
    record.status = input.status;
    record.outputSummary = input.outputSummary ?? {};
    record.errorCode = input.error?.code ?? null;
    record.errorSummary = input.error?.summary ?? null;
    record.retryable = input.error?.retryable ?? null;
    record.completedAt = new Date().toISOString();
    record.durationMs = Math.max(
      0,
      Date.parse(record.completedAt) - Date.parse(record.startedAt),
    );
  }

  async claimDelivery(input: {
    executionId: string;
    nodeId: string;
    idempotencyKey: string;
    providerChatId: string;
    replyToProviderMessageId: string | null;
    bodyHash: string;
  }): Promise<{ delivery: OutboundDeliveryRecord; created: boolean }> {
    const existing = this.deliveries.get(input.idempotencyKey);
    if (existing !== undefined) {
      return { delivery: existing, created: false };
    }
    const now = new Date().toISOString();
    const delivery: OutboundDeliveryRecord = {
      id: randomUUID(),
      executionId: input.executionId,
      nodeId: input.nodeId,
      idempotencyKey: input.idempotencyKey,
      providerChatId: input.providerChatId,
      replyToProviderMessageId: input.replyToProviderMessageId,
      providerTempGuid: randomUUID(),
      providerMessageId: null,
      status: "pending",
      attemptCount: 0,
      errorCode: null,
      errorSummary: null,
      retryable: null,
      createdAt: now,
      updatedAt: now,
      confirmedAt: null,
    };
    this.deliveries.set(input.idempotencyKey, delivery);
    this.requiredExecution(input.executionId).deliveries.push(delivery);
    return { delivery, created: true };
  }

  async markDeliverySending(deliveryId: string): Promise<void> {
    const delivery = this.requiredDelivery(deliveryId);
    delivery.status = "sending";
    delivery.attemptCount += 1;
    delivery.updatedAt = new Date().toISOString();
  }

  async confirmDelivery(
    deliveryId: string,
    providerMessageId: string | null,
  ): Promise<void> {
    const delivery = this.requiredDelivery(deliveryId);
    delivery.status = "confirmed";
    delivery.providerMessageId = providerMessageId;
    delivery.errorCode = null;
    delivery.errorSummary = null;
    delivery.retryable = null;
    delivery.updatedAt = new Date().toISOString();
    delivery.confirmedAt = delivery.updatedAt;
  }

  async failDelivery(
    deliveryId: string,
    status: "failed" | "unknown",
    error: { code: string; summary: string; retryable: boolean },
  ): Promise<void> {
    const delivery = this.requiredDelivery(deliveryId);
    delivery.status = status;
    delivery.errorCode = error.code;
    delivery.errorSummary = error.summary;
    delivery.retryable = error.retryable;
    delivery.updatedAt = new Date().toISOString();
  }

  listExecutions(options: {
    limit: number;
    statuses?: readonly WorkflowExecutionStatus[];
    cursor: { timestamp: Date; id: string } | null;
  }): Promise<readonly WorkflowExecutionRecord[]> {
    const statuses = options.statuses ?? [];
    const cursorTimestamp = options.cursor?.timestamp.toISOString();
    return Promise.resolve(
      [...this.executions.values()]
        .filter(
          (execution) =>
            (statuses.length === 0 || statuses.includes(execution.status)) &&
            (cursorTimestamp === undefined ||
              execution.createdAt < cursorTimestamp ||
              (execution.createdAt === cursorTimestamp &&
                execution.id < (options.cursor?.id ?? ""))),
        )
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            right.id.localeCompare(left.id),
        )
        .slice(0, options.limit)
        .map((execution) => this.executionRecord(execution)),
    );
  }

  listExecutionsForMessages(
    providerMessageIds: readonly string[],
  ): Promise<readonly MessageExecutionLink[]> {
    const requested = new Set(providerMessageIds);
    return Promise.resolve(
      [...this.executions.values()]
        .filter((item) => requested.has(item.sourceProviderMessageId))
        .map((item) => ({
          providerMessageId: item.sourceProviderMessageId,
          execution: this.executionRecord(item),
        })),
    );
  }

  getExecution(executionId: string): Promise<ExecutionDetail | null> {
    const execution = this.executions.get(executionId);
    return Promise.resolve(
      execution === undefined
        ? null
        : {
            ...this.executionRecord(execution),
            nodes: structuredClone(execution.nodes),
            deliveries: structuredClone(execution.deliveries),
          },
    );
  }

  getRuntimeSummary(staleRetryBefore: Date): Promise<WorkflowRuntimeSummary> {
    const executions = [...this.executions.values()];
    const count = (status: WorkflowExecutionStatus) =>
      executions.filter((execution) => execution.status === status).length;
    const deadLetters = executions
      .filter((execution) => execution.status === "dead-lettered")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return Promise.resolve({
      executions: {
        created: count("created"),
        running: count("running"),
        retrying: count("retrying"),
        failed: count("failed"),
        deadLettered: deadLetters.length,
        closed: count("closed"),
        staleRetrying: executions.filter(
          (execution) =>
            execution.status === "retrying" &&
            execution.nextRetryAt !== null &&
            Date.parse(execution.nextRetryAt) <= staleRetryBefore.getTime(),
        ).length,
      },
      outbound: {
        sending: [...this.deliveries.values()].filter(
          (delivery) => delivery.status === "sending",
        ).length,
        unknown: [...this.deliveries.values()].filter(
          (delivery) => delivery.status === "unknown",
        ).length,
      },
      oldestDeadLetterAt: deadLetters[0]?.createdAt ?? null,
    });
  }

  isReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private requiredExecution(executionId: string): StoredExecution {
    const execution = this.executions.get(executionId);
    if (execution === undefined) {
      throw new Error("Workflow execution not found.");
    }
    return execution;
  }

  private requiredDelivery(deliveryId: string): OutboundDeliveryRecord {
    const delivery = [...this.deliveries.values()].find(
      (candidate) => candidate.id === deliveryId,
    );
    if (delivery === undefined) {
      throw new Error("Outbound delivery not found.");
    }
    return delivery;
  }

  private executionRecord(execution: StoredExecution): WorkflowExecutionRecord {
    return {
      id: execution.id,
      provider: execution.provider,
      externalEventId: execution.externalEventId,
      providerChatId: execution.sourceEnvelope.chat.providerChatId,
      chatDisplayName: execution.sourceEnvelope.chat.displayName,
      triggerId: execution.triggerId,
      triggerName: execution.triggerName,
      workflowId: execution.workflowId,
      workflowName: execution.workflowName,
      workflowVersionId: execution.workflowVersionId,
      workflowVersion: execution.workflowVersion,
      retryOfExecutionId: execution.retryOfExecutionId,
      recoveryAttempt: execution.recoveryAttempt,
      correlationId: execution.correlationId,
      status: execution.status,
      currentNodeId: execution.currentNodeId,
      errorCode: execution.errorCode,
      errorSummary: execution.errorSummary,
      nextRetryAt: execution.nextRetryAt,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      createdAt: execution.createdAt,
      cachedPromptTokens: execution.cachedPromptTokens,
      cacheEligiblePromptTokens: execution.cacheEligiblePromptTokens,
      cacheHitRate: execution.cacheHitRate,
      summaryCompressionStatus: execution.summaryCompressionStatus,
    };
  }
}
