import type {
  AdminSessionRecord,
  AuditEventInput,
  AuditEventView,
  SensitiveGrantRecord,
} from "./auth-types.js";

export interface AuthRepository {
  createSession(input: {
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<AdminSessionRecord>;
  findActiveSession(
    tokenHash: string,
    now: Date,
  ): Promise<AdminSessionRecord | null>;
  findActiveSessionById(
    sessionId: string,
    now: Date,
  ): Promise<AdminSessionRecord | null>;
  touchSession(sessionId: string, now: Date): Promise<void>;
  revokeSession(sessionId: string, now: Date): Promise<void>;
  saveSensitiveGrant(
    sessionId: string,
    verifiedAt: Date,
    expiresAt: Date,
  ): Promise<SensitiveGrantRecord>;
  findActiveSensitiveGrant(
    sessionId: string,
    now: Date,
  ): Promise<SensitiveGrantRecord | null>;
  recordAudit(event: AuditEventInput): Promise<AuditEventView>;
  listAuditEvents(limit: number): Promise<readonly AuditEventView[]>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
