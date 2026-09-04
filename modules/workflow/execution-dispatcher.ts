import type { MessageEnvelope } from "../ingestion/message-envelope.js";
import type { ConversationSummaryTrigger } from "./conversation-context-service.js";
import type { AutomationResult, MessageAutomation } from "./workflow-engine.js";

export interface WorkflowExecutionDispatcher {
  readonly mode: "in-process" | "external-worker";
  dispatch(
    envelope: MessageEnvelope,
    options?: { summaryTrigger?: ConversationSummaryTrigger },
  ): Promise<AutomationResult>;
}

export class InProcessWorkflowExecutionDispatcher implements WorkflowExecutionDispatcher {
  readonly mode = "in-process" as const;

  constructor(private readonly automation: MessageAutomation) {}

  dispatch(
    envelope: MessageEnvelope,
    options?: { summaryTrigger?: ConversationSummaryTrigger },
  ): Promise<AutomationResult> {
    return this.automation.handleMessage(envelope, options);
  }
}
