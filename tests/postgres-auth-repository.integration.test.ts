import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresAuthRepository } from "../modules/auth/postgres-auth-repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(testDatabaseUrl !== undefined)("PostgresAuthRepository", () => {
  let repository: PostgresAuthRepository;

  beforeAll(() => {
    repository = new PostgresAuthRepository(testDatabaseUrl ?? "");
  });

  afterAll(async () => {
    await repository.close();
  });

  it("persists hashed sessions, bound grants, revocation, and audit events", async () => {
    const now = new Date();
    const tokenHash = `fictional-token-hash-${randomUUID()}`;
    const session = await repository.createSession({
      tokenHash,
      now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await expect(
      repository.findActiveSession(tokenHash, now),
    ).resolves.toMatchObject({ id: session.id, tokenHash });

    const grant = await repository.saveSensitiveGrant(
      session.id,
      now,
      new Date(now.getTime() + 30_000),
    );
    await expect(
      repository.findActiveSensitiveGrant(session.id, now),
    ).resolves.toEqual(grant);

    const audit = await repository.recordAudit({
      actorType: "session",
      actorSessionId: session.id,
      action: "fictional.operation",
      targetType: "fictional-target",
      targetId: randomUUID(),
      outcome: "succeeded",
      correlationId: randomUUID(),
      metadata: { fixture: true },
    });
    await expect(repository.listAuditEvents(200)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: audit.id, metadata: { fixture: true } }),
      ]),
    );

    await repository.revokeSession(session.id, now);
    await expect(
      repository.findActiveSession(tokenHash, now),
    ).resolves.toBeNull();
    await expect(
      repository.findActiveSensitiveGrant(session.id, now),
    ).resolves.toBeNull();
  });
});
