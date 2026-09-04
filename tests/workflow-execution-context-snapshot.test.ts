import { describe, expect, it } from "vitest";

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
