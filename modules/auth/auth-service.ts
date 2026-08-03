import { randomBytes } from "node:crypto";

import { sha256 } from "../../app/canonical-json.js";
import { verifyPassword } from "../../app/security.js";
import type { AuthRepository } from "./auth-repository.js";
import type {
  AdminSessionView,
  AuditEventInput,
  AuditEventView,
} from "./auth-types.js";

export interface AuthServiceOptions {
  loginPasswordHash: string;
  sensitiveOperationPasswordHash: string;
  sessionTtlSeconds: number;
  sensitiveOperationTtlSeconds: number;
  now?: () => Date;
}

export type LoginResult =
  | {
      status: "authenticated";
      token: string;
      sessionId: string;
      session: AdminSessionView;
    }
  | { status: "invalid-credentials" };

export type SensitiveVerificationResult =
  | { status: "verified"; session: AdminSessionView }
  | { status: "invalid-credentials" };

export class AuthService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: AuthRepository,
    private readonly options: AuthServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async login(password: string): Promise<LoginResult> {
    if (!(await verifyPassword(password, this.options.loginPasswordHash))) {
      return { status: "invalid-credentials" };
    }
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const record = await this.repository.createSession({
      tokenHash: sha256(token),
      expiresAt: new Date(
        now.getTime() + this.options.sessionTtlSeconds * 1_000,
      ),
      now,
    });
    return {
      status: "authenticated",
      token,
      sessionId: record.id,
      session: {
        expiresAt: record.expiresAt,
        sensitiveUntil: null,
      },
    };
  }

  async authenticate(token: string): Promise<{
    sessionId: string;
    session: AdminSessionView;
  } | null> {
    const now = this.now();
    const session = await this.repository.findActiveSession(sha256(token), now);
    if (session === null) {
      return null;
    }
    await this.repository.touchSession(session.id, now);
    const grant = await this.repository.findActiveSensitiveGrant(
      session.id,
      now,
    );
    return {
      sessionId: session.id,
      session: {
        expiresAt: session.expiresAt,
        sensitiveUntil: grant?.expiresAt ?? null,
      },
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.repository.revokeSession(sessionId, this.now());
  }

  async verifySensitiveOperation(
    sessionId: string,
    password: string,
  ): Promise<SensitiveVerificationResult> {
    if (
      !(await verifyPassword(
        password,
        this.options.sensitiveOperationPasswordHash,
      ))
    ) {
      return { status: "invalid-credentials" };
    }
    const now = this.now();
    const session = await this.repository.findActiveSessionById(sessionId, now);
    if (session === null) {
      return { status: "invalid-credentials" };
    }
    const grant = await this.repository.saveSensitiveGrant(
      sessionId,
      now,
      new Date(
        now.getTime() + this.options.sensitiveOperationTtlSeconds * 1_000,
      ),
    );
    return {
      status: "verified",
      session: {
        expiresAt: session.expiresAt,
        sensitiveUntil: grant.expiresAt,
      },
    };
  }

  async hasSensitiveGrant(sessionId: string): Promise<boolean> {
    return (
      (await this.repository.findActiveSensitiveGrant(
        sessionId,
        this.now(),
      )) !== null
    );
  }

  recordAudit(event: AuditEventInput): Promise<AuditEventView> {
    return this.repository.recordAudit(event);
  }

  listAuditEvents(limit: number): Promise<readonly AuditEventView[]> {
    return this.repository.listAuditEvents(limit);
  }

  isReady(): Promise<boolean> {
    return this.repository.isReady();
  }

  close(): Promise<void> {
    return this.repository.close();
  }
}
