import type { MessageEnvelope } from "../ingestion/message-envelope.js";

export interface ChatIdleEvent {
  schemaVersion: "chat-idle-v1";
  eventId: string;
  correlationId: string;
  provider: "bluebubbles";
  chat: MessageEnvelope["chat"];
  message: null;
  idle: {
    chatId: string;
    activityGeneration: string;
    lastActivityAt: string;
    lastMessageIndex: string;
    upperMessageIndex: string;
    triggeredAt: string;
    workflowVersionId: string;
    taskInstruction: string;
  };
}
export type WorkflowEvent = MessageEnvelope | ChatIdleEvent;
export function triggerType(event: WorkflowEvent): "message" | "chat-idle" {
  return event.message === null ? "chat-idle" : "message";
}
