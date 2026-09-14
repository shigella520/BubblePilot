import { WorkflowExecutionError } from "../modules/workflow/workflow-errors.js";
import { defaultAgentSettings } from "../modules/ai/agent-settings-types.js";
import { WorkflowEngine } from "../modules/workflow/workflow-engine.js";
import { NodeRegistry } from "../modules/workflow/node-registry.js";
import type { HistoryCoverage } from "../modules/workflow/conversation-context-service.js";
import { describe, expect, it, vi } from "vitest";

import type { MessageEnvelope } from "../modules/ingestion/message-envelope.js";
import type { TriggerBinding } from "../modules/workflow/workflow-repository.js";
import { InMemoryWorkflowRepository } from "./support/in-memory-workflow-repository.js";

const envelope: MessageEnvelope = {
  schemaVersion: "3",
  eventId: "new-message:context-snapshot",
  correlationId: "11111111-1111-4111-8111-111111111111",
  provider: "bluebubbles",
  chat: {
    providerChatId: "iMessage;-;fictional-context-chat",
    type: "direct",
    displayName: "Fictional context chat",
  },
  message: {
    providerMessageId: "fictional-context-message",
    senderId: "alice@example.test",
    sentAt: "2026-09-04T00:00:00.000Z",
    text: "Fictional current message",
    contentType: "text",
    isFromMe: false,
    attachments: [],
    linkPreview: { status: "not-requested", errorCode: null, items: [] },
    contentHash: "fictional-context-content-hash",
  },
  metadata: {
    isReplay: false,
    payloadHash: "fictional-context-payload-hash",
    eventType: "new-message",
    adapterVersion: "1",
  },
};

const trigger: TriggerBinding = {
  id: "11111111-1111-4111-8111-111111111112",
  name: "Fictional trigger",
  workflowId: "11111111-1111-4111-8111-111111111113",
  workflowVersionId: "11111111-1111-4111-8111-111111111114",
  workflowVersion: 1,
  conditions: {
    chatIds: [],
    senderIds: [],
    contentTypes: [],
    text: null,
    timeWindow: null,
  },
  includeFromMe: false,
  enabled: true,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
  definition: {
    schemaVersion: "1",
    name: "fictional-context-workflow",
    startNodeId: "done",
    maxSteps: 1,
    nodes: [
      {
        id: "done",
        type: "end",
        version: 1,
        config: { result: "succeeded" },
      },
    ],
  },
};

describe("workflow execution context snapshot", () => {
  it("distinguishes the summary source from the compression scheduled by the trigger", async () => {
    const repository = new InMemoryWorkflowRepository();

    const result = await repository.createExecution({
      envelope,
      trigger,
      summaryTrigger: {
        triggerMessageIndex: "42",
        compressionOperationId: "scheduled-operation",
        summarySnapshot: {
          stateId: "summary-state",
          chatId: "internal-chat-uuid",
          summaryVersion: 7,
          coveredThroughIndex: "31",
          summaryPolicyVersion: 3,
          compressionOperationId: "source-operation",
        },
      },
    });

    expect(result.execution.contextSnapshot).toMatchObject({
      chatId: "internal-chat-uuid",
      providerChatId: "iMessage;-;fictional-context-chat",
      triggerMessageIndex: "42",
      summaryVersion: 7,
      summaryCoveredThroughIndex: "31",
      compressionOperationId: "source-operation",
      scheduledCompressionOperationId: "scheduled-operation",
    });
  });
});

it("shares coverage across node contexts and records the same execution snapshot", async () => {
  const snapshot = vi.fn().mockResolvedValue(undefined);
  const repository = Object.assign(new InMemoryWorkflowRepository(), {
    recordContextSnapshot: snapshot,
  });
  const binding: TriggerBinding = {
    ...trigger,
    definition: {
      ...trigger.definition,
      startNodeId: "load",
      maxSteps: 2,
      nodes: [
        {
          id: "load",
          type: "load-context",
          version: 1,
          config: {},
          onSuccess: "done",
        },
        ...trigger.definition.nodes,
      ],
    },
  };
  vi.spyOn(repository, "listActiveTriggerBindings").mockResolvedValue([
    binding,
  ]);
  const coverage: HistoryCoverage = {
    summaryCoveredThroughIndex: "2",
    retained: null,
    omitted: {
      count: 1,
      firstMessageIndex: "4",
      lastMessageIndex: "4",
      earliestSentAt: "2026-09-01T00:00:00Z",
      latestSentAt: "2026-09-01T00:00:00Z",
    },
  };
  const registry = new NodeRegistry();
  registry.register({
    type: "load-context",
    version: 1,
    retryPolicy: () => ({ maxAttempts: 1, initialDelayMs: 0 }),
    failureTarget: () => null,
    execute: (_node, context) => {
      context.historyCoverage = coverage;
      context.contextIncompleteReasons = ["history-trimmed"];
      return Promise.resolve({
        status: "succeeded",
        nextNodeId: "done",
        outputSummary: {
          historyCoverage: coverage,
          contextIncomplete: true,
          contextIncompleteReasons: ["history-trimmed"],
        },
      });
    },
  });
  let observed: HistoryCoverage | undefined;
  registry.register({
    type: "end",
    version: 1,
    retryPolicy: () => ({ maxAttempts: 1, initialDelayMs: 0 }),
    failureTarget: () => null,
    execute: (_node, context) => {
      observed = context.historyCoverage;
      return Promise.resolve({
        status: "succeeded",
        nextNodeId: null,
        outputSummary: {},
      });
    },
  });
  const result = await new WorkflowEngine(repository, registry).handleMessage(
    envelope,
  );
  expect(observed).toEqual(coverage);
  expect(snapshot).toHaveBeenCalledWith(
    result.executionIds[0],
    expect.objectContaining({
      historyCoverage: coverage,
      contextIncomplete: true,
      contextIncompleteReasons: ["history-trimmed"],
    }),
  );
});

it("persists failed Agent budget metadata in the node JSON snapshot", async () => {
  const repository = new InMemoryWorkflowRepository();
  vi.spyOn(repository, "listActiveTriggerBindings").mockResolvedValue([
    trigger,
  ]);
  const finish = vi.spyOn(repository, "finishNodeExecution");
  const budget = {
    settings: {
      ...defaultAgentSettings,
      source: "defaults",
      version: 0,
      updatedAt: null,
    },
    modelTurns: 3,
    toolCalls: 2,
    toolOutputCharacters: 128,
    toolDurationMs: 30,
    finalizingDueToBudget: true,
    reasons: ["tool-calls"],
    outcome: "failed",
  };
  const registry = new NodeRegistry();
  registry.register({
    type: "end",
    version: 1,
    retryPolicy: () => ({ maxAttempts: 1, initialDelayMs: 0 }),
    failureTarget: () => null,
    execute: () => {
      return Promise.reject(
        new WorkflowExecutionError(
          "AI_AGENT_TOOL_LIMIT_EXCEEDED",
          "Fictional failure",
          false,
          false,
          undefined,
          { agentBudget: budget },
        ),
      );
    },
  });
  await new WorkflowEngine(repository, registry).handleMessage(envelope);
  expect(finish).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "failed",
      outputSummary: { agentBudget: budget },
    }),
  );
});
