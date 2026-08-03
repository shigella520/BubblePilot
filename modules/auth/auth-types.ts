export type AuditActorType = "anonymous" | "session" | "api-token" | "system";
export type AuditOutcome = "succeeded" | "failed" | "denied";

export interface AdminSessionRecord {
  id: string;
  tokenHash: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface SensitiveGrantRecord {
  sessionId: string;
  verifiedAt: string;
  expiresAt: string;
}

export interface AdminSessionView {
  expiresAt: string;
  sensitiveUntil: string | null;
}

export interface AuditEventInput {
  actorType: AuditActorType;
  actorSessionId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: AuditOutcome;
  correlationId: string;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AuditEventView extends AuditEventInput {
  id: string;
  occurredAt: string;
}

export type AdminPrincipal =
  { kind: "api-token" } | { kind: "session"; sessionId: string };
