import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../app/application.js";
import type { AppConfig } from "../app/config.js";
import { hashPassword } from "../app/security.js";
import { AuthService } from "../modules/auth/auth-service.js";
import { DataExportService } from "../modules/export/export-service.js";
import { InMemoryArchiveRepository } from "./support/in-memory-archive-repository.js";
import { InMemoryAuthRepository } from "./support/in-memory-auth-repository.js";
import { InMemoryDataExportRepository } from "./support/in-memory-export-repository.js";

const loginPassword = "fictional-export-login-password";
const sensitivePassword = "fictional-export-sensitive-password";
const chatId = "00000000-0000-4000-8000-000000000101";
let loginPasswordHash: string;
let sensitiveOperationPasswordHash: string;

beforeAll(async () => {
  loginPasswordHash = await hashPassword(
    loginPassword,
    Buffer.from("export-login-salt"),
  );
  sensitiveOperationPasswordHash = await hashPassword(
    sensitivePassword,
    Buffer.from("export-stepup-salt"),
  );
});

describe("bounded data export API", () => {
  let application: FastifyInstance;
  let authRepository: InMemoryAuthRepository;
  let exportRepository: InMemoryDataExportRepository;

  beforeEach(() => {
    const config: AppConfig = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 8080,
      databaseUrl: "postgresql://unused.example.test/bubblepilot",
      databaseQueryTimeoutMs: 30_000,
      apiAccessToken: "fictional-api-access-token-32-chars-long",
      settingsEncryptionKey: "fictional-settings-encryption-key-32-chars",
      loginPasswordHash,
      sensitiveOperationPasswordHash,
      adminSessionTtlSeconds: 43_200,
      sensitiveOperationTtlSeconds: 300,
      sessionCookieSecure: "auto",
      blueBubblesWebhookSecret: "fictional-webhook-secret-32-chars-long",
      blueBubblesServerUrl: "https://bluebubbles.example.test",
      blueBubblesAccessToken: "fictional-bluebubbles-token",
      blueBubblesSendMethod: "private-api",
      blueBubblesRequestTimeoutMs: 30_000,
      monitoredChatIds: new Set(),
      messageRetentionDays: 90,
      webhookBodyLimitBytes: 1_048_576,
      rateLimitWindowSeconds: 60,
      adminRateLimitMax: 600,
      webhookRateLimitMax: 300,
      workflowMaxConcurrency: 4,
      workflowQueueCapacity: 64,
      workflowQueueWaitMs: 30_000,
      staleRetrySeconds: 300,
      logLevel: "silent",
    };
    authRepository = new InMemoryAuthRepository();
    exportRepository = new InMemoryDataExportRepository();
    exportRepository.enabledChatIds.add(chatId);
    exportRepository.messages.push({
      id: "00000000-0000-4000-8000-000000000102",
      providerMessageId: "fictional-export-message",
      chatId,
      providerChatId: "iMessage;-;fictional-export-chat",
      chatDisplayName: "Fictional export chat",
      senderId: "fictional-export-user@example.test",
      sentAt: "2026-08-03T08:00:00.000Z",
      body: "Fictional export body",
      contentType: "text",
      isFromMe: false,
      attachments: [],
      linkPreview: {
        status: "not-requested",
        errorCode: null,
        items: [],
      },
      contentRedactedAt: null,
      createdAt: "2026-08-03T08:00:01.000Z",
    });
    const service = new DataExportService(exportRepository);
    application = buildApplication(config, new InMemoryArchiveRepository(), {
      logger: false,
      auth: new AuthService(authRepository, {
        loginPasswordHash,
        sensitiveOperationPasswordHash,
        sessionTtlSeconds: config.adminSessionTtlSeconds,
        sensitiveOperationTtlSeconds: config.sensitiveOperationTtlSeconds,
      }),
      dataExport: { repository: exportRepository, service },
    });
  });

  afterEach(async () => {
    await application.close();
  });

  async function login(): Promise<string> {
    const response = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    expect(response.statusCode).toBe(201);
    const setCookie = response.headers["set-cookie"];
    return Array.isArray(setCookie) ? (setCookie[0] ?? "") : (setCookie ?? "");
  }

  async function unlock(cookie: string): Promise<void> {
    const response = await application.inject({
      method: "POST",
      url: "/api/v1/auth/sensitive",
      headers: { cookie },
      payload: { password: sensitivePassword },
    });
    expect(response.statusCode).toBe(200);
  }

  async function preview(cookie: string) {
    const response = await application.inject({
      method: "POST",
      url: "/api/v1/exports/preview",
      headers: { cookie },
      payload: {
        chatId,
        sentFrom: "2026-08-03T00:00:00.000Z",
        sentTo: "2026-08-04T00:00:00.000Z",
        types: ["messages", "executions"],
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{
      data: { id: string; recordCount: number; snapshotAt: string };
    }>().data;
  }

  it("previews, explicitly confirms, downloads, and audits a scoped export", async () => {
    const cookie = await login();
    const job = await preview(cookie);
    expect(job.recordCount).toBe(1);

    const denied = await application.inject({
      method: "POST",
      url: `/api/v1/exports/${job.id}/confirm`,
      headers: { cookie },
      payload: {
        expectedRecordCount: job.recordCount,
        expectedSnapshotAt: job.snapshotAt,
      },
    });
    expect(denied.statusCode).toBe(403);

    await unlock(cookie);
    const stale = await application.inject({
      method: "POST",
      url: `/api/v1/exports/${job.id}/confirm`,
      headers: { cookie },
      payload: {
        expectedRecordCount: 0,
        expectedSnapshotAt: job.snapshotAt,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: "DATA_EXPORT_CONFLICT" },
    });

    const confirmed = await application.inject({
      method: "POST",
      url: `/api/v1/exports/${job.id}/confirm`,
      headers: { cookie },
      payload: {
        expectedRecordCount: job.recordCount,
        expectedSnapshotAt: job.snapshotAt,
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ data: { status: "ready" } });

    const downloaded = await application.inject({
      method: "GET",
      url: `/api/v1/exports/${job.id}/download`,
      headers: { cookie },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["cache-control"]).toBe("no-store");
    expect(downloaded.headers["content-disposition"]).toContain(
      `bubblepilot-export-${job.id}.jsonl`,
    );
    expect(downloaded.body).toContain('"type":"manifest"');
    expect(downloaded.body).toContain("Fictional export body");
    expect(downloaded.body).toContain('"contentRedactedAt":null');
    expect(downloaded.body).not.toContain(
      "fictional-export-sensitive-password",
    );
    expect(authRepository.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "data.export.preview",
          outcome: "succeeded",
        }),
        expect.objectContaining({
          action: "data.export.create",
          outcome: "denied",
        }),
        expect.objectContaining({
          action: "data.export.create",
          outcome: "failed",
        }),
        expect.objectContaining({
          action: "data.export.create",
          outcome: "succeeded",
        }),
        expect.objectContaining({
          action: "data.export.download",
          outcome: "succeeded",
        }),
      ]),
    );
  });

  it("isolates jobs by session and audits explicit cancellation", async () => {
    const ownerCookie = await login();
    const job = await preview(ownerCookie);
    const otherCookie = await login();
    const isolated = await application.inject({
      method: "GET",
      url: "/api/v1/exports",
      headers: { cookie: otherCookie },
    });
    expect(isolated.json()).toMatchObject({ data: [] });

    await unlock(ownerCookie);
    const cancelled = await application.inject({
      method: "DELETE",
      url: `/api/v1/exports/${job.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ data: { status: "revoked" } });
    expect(authRepository.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "data.export.cancel",
          outcome: "succeeded",
        }),
      ]),
    );
  });

  it("paginates export jobs and stops at the final page", async () => {
    const cookie = await login();
    await preview(cookie);
    await preview(cookie);
    await preview(cookie);

    const first = await application.inject({
      method: "GET",
      url: "/api/v1/exports?limit=2",
      headers: { cookie },
    });
    const firstPage = first.json<{
      data: Array<{ id: string }>;
      page: { nextCursor: string | null };
    }>();
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.page.nextCursor).toEqual(expect.any(String));

    const second = await application.inject({
      method: "GET",
      url: `/api/v1/exports?limit=2&cursor=${encodeURIComponent(
        firstPage.page.nextCursor ?? "",
      )}`,
      headers: { cookie },
    });
    const secondPage = second.json<{
      data: Array<{ id: string }>;
      page: { nextCursor: string | null };
    }>();
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.page.nextCursor).toBeNull();
    expect(firstPage.data.map((item) => item.id)).not.toContain(
      secondPage.data[0]?.id,
    );
  });

  it("rejects unavailable chats and ranges longer than 31 days", async () => {
    const cookie = await login();
    const unavailable = await application.inject({
      method: "POST",
      url: "/api/v1/exports/preview",
      headers: { cookie },
      payload: {
        chatId: "00000000-0000-4000-8000-000000000999",
        sentFrom: "2026-08-03T00:00:00.000Z",
        sentTo: "2026-08-04T00:00:00.000Z",
        types: ["messages"],
      },
    });
    expect(unavailable.statusCode).toBe(404);

    const excessive = await application.inject({
      method: "POST",
      url: "/api/v1/exports/preview",
      headers: { cookie },
      payload: {
        chatId,
        sentFrom: "2026-06-01T00:00:00.000Z",
        sentTo: "2026-08-04T00:00:00.000Z",
        types: ["messages"],
      },
    });
    expect(excessive.statusCode).toBe(400);
  });
});
