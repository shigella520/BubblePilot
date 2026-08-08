import { z } from "zod";

export const dataExportScopeSchema = z
  .object({
    chatId: z.string().uuid(),
    sentFrom: z.string().datetime({ offset: true }),
    sentTo: z.string().datetime({ offset: true }),
    types: z
      .array(z.enum(["messages", "executions"]))
      .min(1)
      .max(2)
      .refine((types) => new Set(types).size === types.length, {
        message: "Export data types must be unique.",
      }),
  })
  .superRefine((scope, context) => {
    const sentFrom = Date.parse(scope.sentFrom);
    const sentTo = Date.parse(scope.sentTo);
    if (sentFrom > sentTo) {
      context.addIssue({
        code: "custom",
        path: ["sentTo"],
        message: "sentFrom must not be later than sentTo.",
      });
    }
    if (sentTo - sentFrom > 31 * 24 * 60 * 60 * 1_000) {
      context.addIssue({
        code: "custom",
        path: ["sentTo"],
        message: "An export range cannot exceed 31 days.",
      });
    }
  });

export const dataExportConfirmSchema = z.object({
  expectedRecordCount: z.number().int().min(0).max(10_000),
  expectedSnapshotAt: z.string().datetime({ offset: true }),
});

export type DataExportType = "messages" | "executions";

export interface DataExportScope {
  chatId: string;
  sentFrom: string;
  sentTo: string;
  types: readonly DataExportType[];
}

export interface DataExportOwner {
  actorType: "session" | "api-token";
  actorSessionId: string | null;
}

export type DataExportJobStatus =
  "awaiting-confirmation" | "ready" | "revoked" | "expired";

export interface DataExportJob {
  id: string;
  scope: DataExportScope;
  snapshotAt: string;
  messageCount: number;
  executionCount: number;
  recordCount: number;
  estimatedBytes: number;
  status: DataExportJobStatus;
  expiresAt: string;
  confirmedAt: string | null;
  downloadedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface DataExportMessage {
  id: string;
  providerMessageId: string;
  chatId: string;
  providerChatId: string;
  chatDisplayName: string | null;
  senderId: string | null;
  sentAt: string;
  body: string | null;
  contentType: string;
  isFromMe: boolean;
  attachments: readonly unknown[];
  linkPreview: unknown;
  contentRedactedAt: string | null;
  createdAt: string;
}

export interface DataExportExecution {
  id: string;
  sourceMessageId: string;
  triggerId: string;
  triggerName: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  correlationId: string;
  status: string;
  currentNodeId: string | null;
  errorCode: string | null;
  nextRetryAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface DataExportContent {
  messages: readonly DataExportMessage[];
  executions: readonly DataExportExecution[];
}

export type DataExportPreviewResult =
  | { status: "ok"; value: DataExportJob }
  | { status: "scope-unavailable" }
  | {
      status: "too-large";
      recordCount: number;
      estimatedBytes: number;
    };

export type DataExportMutationResult =
  | { status: "ok"; value: DataExportJob }
  | { status: "not-found" }
  | { status: "expired" }
  | { status: "conflict"; reason: string };

export type DataExportReadResult =
  | { status: "ok"; job: DataExportJob; content: DataExportContent }
  | { status: "not-found" }
  | { status: "expired" }
  | { status: "not-ready" }
  | { status: "scope-unavailable" }
  | { status: "conflict" };
