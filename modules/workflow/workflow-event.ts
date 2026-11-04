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
export interface ScheduledTaskEvent {
  schemaVersion: "scheduled-task-v1";
  eventId: string;
  correlationId: string;
  provider: "bluebubbles";
  chat: MessageEnvelope["chat"];
  message: null;
  scheduled: {
    taskId: string;
    taskVersion: number;
    chatId: string;
    content: string;
    requestSnapshot: string;
    creatorSenderId: string;
    scheduledAt: string;
    triggeredAt: string;
    timeZone: string;
    upperMessageIndex: string;
    workflowVersionId: string;
  };
}
export type BackgroundWorkflowEvent = ChatIdleEvent | ScheduledTaskEvent;
export type WorkflowEvent = MessageEnvelope | BackgroundWorkflowEvent;
export function backgroundMetadata(event: BackgroundWorkflowEvent) {
  return event.schemaVersion === "chat-idle-v1" ? event.idle : event.scheduled;
}
export function triggerType(
  event: WorkflowEvent,
): "message" | "chat-idle" | "scheduled-task" {
  return event.message !== null
    ? "message"
    : event.schemaVersion === "chat-idle-v1"
      ? "chat-idle"
      : "scheduled-task";
}
