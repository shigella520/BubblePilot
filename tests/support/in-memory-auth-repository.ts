import { randomUUID } from "node:crypto";

import type { AuthRepository } from "../../modules/auth/auth-repository.js";
import type {
  AdminSessionRecord,
  AuditEventInput,
  AuditEventView,
  SensitiveGrantRecord,
} from "../../modules/auth/auth-types.js";

export class InMemoryAuthRepository implements AuthRepository {
  readonly sessions = new Map<string, AdminSessionRecord>();
  readonly grants = new Map<string, SensitiveGrantRecord>();
  readonly auditEvents: AuditEventView[] = [];

  async createSession(input: {
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<AdminSessionRecord> {
    const record: AdminSessionRecord = {
      id: randomUUID(),
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt.toISOString(),
      lastSeenAt: input.now.toISOString(),
      revokedAt: null,
      createdAt: input.now.toISOString(),
    };
    this.sessions.set(record.id, record);
    return record;
  }

  findActiveSession(
    tokenHash: string,
    now: Date,
  ): Promise<AdminSessionRecord | null> {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.tokenHash === tokenHash,
    );
    return Promise.resolve(this.active(session, now));
  }

  findActiveSessionById(
    sessionId: string,
    now: Date,
  ): Promise<AdminSessionRecord | null> {
    return Promise.resolve(this.active(this.sessions.get(sessionId), now));
  }

  async touchSession(sessionId: string, now: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      this.sessions.set(sessionId, {
        ...session,
        lastSeenAt: now.toISOString(),
      });
    }
  }

  async revokeSession(sessionId: string, now: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      this.sessions.set(sessionId, {
        ...session,
        revokedAt: session.revokedAt ?? now.toISOString(),
      });
    }
  }

  async saveSensitiveGrant(
    sessionId: string,
    verifiedAt: Date,
    expiresAt: Date,
  ): Promise<SensitiveGrantRecord> {
    const grant: SensitiveGrantRecord = {
      sessionId,
      verifiedAt: verifiedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    this.grants.set(sessionId, grant);
    return grant;
  }

  findActiveSensitiveGrant(
    sessionId: string,
    now: Date,
  ): Promise<SensitiveGrantRecord | null> {
    const grant = this.grants.get(sessionId);
    const session = this.active(this.sessions.get(sessionId), now);
    return Promise.resolve(
      grant !== undefined &&
        session !== null &&
        grant.expiresAt > now.toISOString()
        ? grant
        : null,
    );
  }

  async recordAudit(event: AuditEventInput): Promise<AuditEventView> {
    const record: AuditEventView = {
      ...event,
      metadata: event.metadata ?? {},
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
    };
    this.auditEvents.unshift(record);
    return record;
  }

  listAuditEvents(limit: number): Promise<readonly AuditEventView[]> {
    return Promise.resolve(this.auditEvents.slice(0, limit));
  }

  async isReady(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}

  private active(
    session: AdminSessionRecord | undefined,
    now: Date,
  ): AdminSessionRecord | null {
    return session !== undefined &&
      session.revokedAt === null &&
      session.expiresAt > now.toISOString()
      ? session
      : null;
  }
}
