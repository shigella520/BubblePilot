import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type { AuthRepository } from "./auth-repository.js";
import type {
  AdminSessionRecord,
  AuditEventInput,
  AuditEventView,
  SensitiveGrantRecord,
} from "./auth-types.js";

interface SessionRow {
  id: string;
  token_hash: string;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

interface GrantRow {
  session_id: string;
  verified_at: Date;
  expires_at: Date;
}

interface AuditRow {
  id: string;
  actor_type: AuditEventView["actorType"];
  actor_session_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  outcome: AuditEventView["outcome"];
  correlation_id: string;
  metadata: Record<string, string | number | boolean | null>;
  occurred_at: Date;
}

function sessionRecord(row: SessionRow): AdminSessionRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function grantRecord(row: GrantRow): SensitiveGrantRecord {
  return {
    sessionId: row.session_id,
    verifiedAt: row.verified_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

function auditRecord(row: AuditRow): AuditEventView {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorSessionId: row.actor_session_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    outcome: row.outcome,
    correlationId: row.correlation_id,
    metadata: row.metadata,
    occurredAt: row.occurred_at.toISOString(),
  };
}

export class PostgresAuthRepository implements AuthRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }

  async createSession(input: {
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<AdminSessionRecord> {
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO admin_sessions (
         id, token_hash, expires_at, last_seen_at, created_at
       ) VALUES ($1, $2, $3, $4, $4)
       RETURNING id, token_hash, expires_at, last_seen_at, revoked_at, created_at`,
      [randomUUID(), input.tokenHash, input.expiresAt, input.now],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("The created admin session could not be read.");
    }
    return sessionRecord(row);
  }

  async findActiveSession(
    tokenHash: string,
    now: Date,
  ): Promise<AdminSessionRecord | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT id, token_hash, expires_at, last_seen_at, revoked_at, created_at
       FROM admin_sessions
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [tokenHash, now],
    );
    const row = result.rows[0];
    return row === undefined ? null : sessionRecord(row);
  }

  async findActiveSessionById(
    sessionId: string,
    now: Date,
  ): Promise<AdminSessionRecord | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT id, token_hash, expires_at, last_seen_at, revoked_at, created_at
       FROM admin_sessions
       WHERE id = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [sessionId, now],
    );
    const row = result.rows[0];
    return row === undefined ? null : sessionRecord(row);
  }

  async touchSession(sessionId: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE admin_sessions SET last_seen_at = $2
       WHERE id = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [sessionId, now],
    );
  }

  async revokeSession(sessionId: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, $2)
       WHERE id = $1`,
      [sessionId, now],
    );
  }

  async saveSensitiveGrant(
    sessionId: string,
    verifiedAt: Date,
    expiresAt: Date,
  ): Promise<SensitiveGrantRecord> {
    const result = await this.pool.query<GrantRow>(
      `INSERT INTO sensitive_operation_grants (session_id, verified_at, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO UPDATE SET
         verified_at = EXCLUDED.verified_at,
         expires_at = EXCLUDED.expires_at
       RETURNING session_id, verified_at, expires_at`,
      [sessionId, verifiedAt, expiresAt],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("The sensitive operation grant could not be read.");
    }
    return grantRecord(row);
  }

  async findActiveSensitiveGrant(
    sessionId: string,
    now: Date,
  ): Promise<SensitiveGrantRecord | null> {
    const result = await this.pool.query<GrantRow>(
      `SELECT g.session_id, g.verified_at, g.expires_at
       FROM sensitive_operation_grants g
       INNER JOIN admin_sessions s ON s.id = g.session_id
       WHERE g.session_id = $1
         AND g.expires_at > $2
         AND s.revoked_at IS NULL
         AND s.expires_at > $2`,
      [sessionId, now],
    );
    const row = result.rows[0];
    return row === undefined ? null : grantRecord(row);
  }

  async recordAudit(event: AuditEventInput): Promise<AuditEventView> {
    const result = await this.pool.query<AuditRow>(
      `INSERT INTO audit_events (
         id, actor_type, actor_session_id, action, target_type, target_id,
         outcome, correlation_id, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING id, actor_type, actor_session_id, action, target_type,
                 target_id, outcome, correlation_id, metadata, occurred_at`,
      [
        randomUUID(),
        event.actorType,
        event.actorSessionId,
        event.action,
        event.targetType,
        event.targetId,
        event.outcome,
        event.correlationId,
        JSON.stringify(event.metadata ?? {}),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("The audit event could not be read.");
    }
    return auditRecord(row);
  }

  async listAuditEvents(limit: number): Promise<readonly AuditEventView[]> {
    const result = await this.pool.query<AuditRow>(
      `SELECT id, actor_type, actor_session_id, action, target_type, target_id,
              outcome, correlation_id, metadata, occurred_at
       FROM audit_events
       ORDER BY occurred_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(auditRecord);
  }

  async isReady(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ ready: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM schema_migrations WHERE name = '0004_web_admin.sql'
         ) AS ready`,
      );
      return result.rows[0]?.ready === true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
