export type ReplyWakeStatus =
  | "resolved"
  | "unmatched"
  | "ambiguous"
  | "unavailable"
  | "from-me"
  | "no-reference"
  | "lookup-error";

export interface ReplyWakeSnapshot {
  status: ReplyWakeStatus | "legacy";
  workflowId: string | null;
  decision?: ReplyWakeDecision | null;
  triggerId?: string | null;
  workflowVersionId?: string | null;
}

export type ReplyWakeDecision =
  "ordinary" | "reply" | "blocked" | "not-applicable";

export type MessageMatchSource = "ordinary" | "reply";

export interface ReplyWakeChoice {
  decision: ReplyWakeDecision;
  triggerId: string | null;
  workflowVersionId: string | null;
}
