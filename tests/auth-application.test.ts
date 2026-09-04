import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../app/application.js";
import type { AppConfig } from "../app/config.js";
import { hashPassword } from "../app/security.js";
import { AiManagementService } from "../modules/ai/ai-management-service.js";
import type { AiClient } from "../modules/ai/openai-compatible-client.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import type { AiCallResult, AiProviderRecord } from "../modules/ai/ai-types.js";
import { AuthService } from "../modules/auth/auth-service.js";
import type { MessageAutomation } from "../modules/workflow/workflow-engine.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";
import { InMemoryArchiveRepository } from "./support/in-memory-archive-repository.js";
import { InMemoryAuthRepository } from "./support/in-memory-auth-repository.js";
import { InMemoryWorkflowRepository } from "./support/in-memory-workflow-repository.js";

const loginPassword = "fictional-login-password";
const sensitivePassword = "fictional-sensitive-password";
const compressionContentId = "00000000-0000-4000-8000-000000000042";
let loginPasswordHash: string;
let sensitiveOperationPasswordHash: string;

class SuccessfulAiClient implements AiClient {
  call(provider: AiProviderRecord): Promise<AiCallResult> {
    void provider;
    return Promise.resolve({
      status: "succeeded",
      text: "OK",
      durationMs: 7,
    });
  }
}

beforeAll(async () => {
  loginPasswordHash = await hashPassword(
    loginPassword,
    Buffer.from("login-test-salt-1"),
  );
  sensitiveOperationPasswordHash = await hashPassword(
    sensitivePassword,
    Buffer.from("stepup-test-salt"),
  );
});

describe("Web admin authentication", () => {
  let application: FastifyInstance;
  let authRepository: InMemoryAuthRepository;

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
    const aiRepository = new InMemoryAiRepository();
    const secrets = new EnvironmentSecretResolver({
      PREVIEW_AI_KEY: "fictional-server-secret",
    });
    const workflowRepository = new InMemoryWorkflowRepository();
    const workflowEngine: MessageAutomation = {
      handleMessage: () =>
        Promise.resolve({
          executionIds: [],
          matchedTriggerIds: [],
          activeTriggerCount: 0,
        }),
      retryExecution: () => Promise.resolve({ status: "not-found" }),
      closeExecution: () => Promise.resolve({ status: "not-found" }),
      runtimeStatus: () => ({
        active: 0,
        queued: 0,
        maxConcurrency: 4,
        queueCapacity: 64,
      }),
    };
    application = buildApplication(config, new InMemoryArchiveRepository(), {
      logger: false,
      auth: new AuthService(authRepository, {
        loginPasswordHash,
        sensitiveOperationPasswordHash,
        sessionTtlSeconds: config.adminSessionTtlSeconds,
        sensitiveOperationTtlSeconds: config.sensitiveOperationTtlSeconds,
      }),
      ai: {
        repository: aiRepository,
        management: new AiManagementService(
          aiRepository,
          new SuccessfulAiClient(),
          secrets,
        ),
      },
      workflow: {
        repository: workflowRepository,
        engine: workflowEngine,
        contextState: {
          close: () => Promise.resolve(),
          getCompressionContent: (id) =>
            Promise.resolve(
              id === compressionContentId
                ? {
                    id,
                    chatId: "00000000-0000-4000-8000-000000000043",
                    providerChatId: "fictional-chat",
                    chatDisplayName: "Fictional chat",
                    status: "succeeded" as const,
                    fromMessageIndex: "10",
                    throughMessageIndex: "12",
                    baseVersion: 3,
                    outputVersion: 4,
                    previousSummary: "Fictional previous summary",
                    outputSummary: "Fictional compressed summary",
                    messages: [
                      {
                        messageIndex: "10",
                        providerMessageId: "fictional-message-10",
                        senderId: "fictional-sender",
                        sentAt: "2026-01-01T00:00:00.000Z",
                        body: "Fictional meal note",
                        isFromMe: false,
                      },
                    ],
                  }
                : null,
            ),
        },
      },
    });
  });

  afterEach(async () => {
    await application.close();
  });

  it("creates an opaque server session and audits failed login attempts", async () => {
    const failed = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: "wrong-password" },
    });
    expect(failed.statusCode).toBe(401);
    expect(failed.headers["set-cookie"]).toBeUndefined();

    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    expect(login.statusCode).toBe(201);
    const cookie = login.headers["set-cookie"];
    expect(cookie).toContain("bubblepilot_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");
    expect([...authRepository.sessions.values()][0]?.tokenHash).not.toContain(
      cookie,
    );
    expect(authRepository.auditEvents.map((event) => event.outcome)).toEqual([
      "succeeded",
      "failed",
    ]);
  });

  it("adds Secure only when auto mode observes HTTPS", async () => {
    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      headers: { "x-forwarded-proto": "https" },
      payload: { password: loginPassword },
    });
    expect(login.statusCode).toBe(201);
    expect(login.headers["set-cookie"]).toContain("Secure");
  });

  it("requires a short-lived session-bound grant for message content", async () => {
    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const cookie = login.headers["set-cookie"];

    const chats = await application.inject({
      method: "GET",
      url: "/api/v1/chats",
      headers: { cookie },
    });
    expect(chats.statusCode).toBe(200);

    const denied = await application.inject({
      method: "GET",
      url: "/api/v1/chats/00000000-0000-4000-8000-000000000001/messages",
      headers: { cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      error: { code: "SENSITIVE_AUTH_REQUIRED" },
    });

    const searchDenied = await application.inject({
      method: "GET",
      url: "/api/v1/messages/search?q=fictional",
      headers: { cookie },
    });
    expect(searchDenied.statusCode).toBe(403);
    expect(searchDenied.json()).toMatchObject({
      error: { code: "SENSITIVE_AUTH_REQUIRED" },
    });

    const invalid = await application.inject({
      method: "POST",
      url: "/api/v1/auth/sensitive",
      headers: { cookie },
      payload: { password: "wrong-password" },
    });
    expect(invalid.statusCode).toBe(401);

    const verified = await application.inject({
      method: "POST",
      url: "/api/v1/auth/sensitive",
      headers: { cookie },
      payload: { password: sensitivePassword },
    });
    expect(verified.statusCode).toBe(200);
    expect(
      verified.json<{ data: { sensitiveUntil: string } }>().data,
    ).toHaveProperty("sensitiveUntil");

    const allowed = await application.inject({
      method: "GET",
      url: "/api/v1/chats/00000000-0000-4000-8000-000000000001/messages",
      headers: { cookie },
    });
    expect(allowed.statusCode).toBe(200);
    const searchAllowed = await application.inject({
      method: "GET",
      url: "/api/v1/messages/search?q=fictional",
      headers: { cookie },
    });
    expect(searchAllowed.statusCode).toBe(200);
    expect(authRepository.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "message.content.view",
          outcome: "denied",
        }),
        expect.objectContaining({
          action: "message.content.view",
          outcome: "succeeded",
        }),
        expect.objectContaining({
          action: "auth.sensitive.verify",
          outcome: "failed",
        }),
        expect.objectContaining({
          action: "message.content.search",
          outcome: "denied",
        }),
        expect.objectContaining({
          action: "message.content.search",
          outcome: "succeeded",
        }),
      ]),
    );
  });

  it("paginates audit events without repeating adjacent records", async () => {
    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const cookie = login.headers["set-cookie"];
    await application.inject({
      method: "POST",
      url: "/api/v1/auth/sensitive",
      headers: { cookie },
      payload: { password: sensitivePassword },
    });

    const first = await application.inject({
      method: "GET",
      url: "/api/v1/audit-events?limit=1",
      headers: { cookie },
    });
    const firstPage = first.json<{
      data: Array<{ id: string }>;
      page: { nextCursor: string | null };
    }>();
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.page.nextCursor).toEqual(expect.any(String));

    const second = await application.inject({
      method: "GET",
      url: `/api/v1/audit-events?limit=1&cursor=${encodeURIComponent(
        firstPage.page.nextCursor ?? "",
      )}`,
      headers: { cookie },
    });
    const secondPage = second.json<{ data: Array<{ id: string }> }>();
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.data[0]?.id).not.toBe(firstPage.data[0]?.id);
  });

  it("allows execution reads after login but keeps recovery sensitive", async () => {
    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const cookie = login.headers["set-cookie"];

    const list = await application.inject({
      method: "GET",
      url: "/api/v1/executions",
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ data: [] });

    const detail = await application.inject({
      method: "GET",
      url: "/api/v1/executions/00000000-0000-4000-8000-000000000001",
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toMatchObject({
      error: { code: "EXECUTION_NOT_FOUND" },
    });

    const retry = await application.inject({
      method: "POST",
      url: "/api/v1/executions/00000000-0000-4000-8000-000000000001/retry",
      headers: { cookie },
    });
    expect(retry.statusCode).toBe(403);
    expect(retry.json()).toMatchObject({
      error: { code: "SENSITIVE_AUTH_REQUIRED" },
    });
  });

  it("protects conversation compression content with the sensitive grant", async () => {
    const anonymous = await application.inject({
      method: "GET",
      url: `/api/v1/conversation-compressions/${compressionContentId}/content`,
    });
    expect(anonymous.statusCode).toBe(401);

    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const cookie = login.headers["set-cookie"];

    const denied = await application.inject({
      method: "GET",
      url: `/api/v1/conversation-compressions/${compressionContentId}/content`,
      headers: { cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      error: { code: "SENSITIVE_AUTH_REQUIRED" },
    });

    const verified = await application.inject({
      method: "POST",
      url: "/api/v1/auth/sensitive",
      headers: { cookie },
      payload: { password: sensitivePassword },
    });
    expect(verified.statusCode).toBe(200);

    const allowed = await application.inject({
      method: "GET",
      url: `/api/v1/conversation-compressions/${compressionContentId}/content`,
      headers: { cookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["cache-control"]).toBe("no-store");
    expect(allowed.headers.pragma).toBe("no-cache");
    const allowedPayload = allowed.json<{
      data: {
        previousSummary: string;
        outputSummary: string | null;
        messages: Array<{ body: string }>;
      };
    }>();
    expect(allowedPayload.data.previousSummary).toBe(
      "Fictional previous summary",
    );
    expect(allowedPayload.data.outputSummary).toBe(
      "Fictional compressed summary",
    );
    expect(allowedPayload.data.messages).toEqual([
      expect.objectContaining({ body: "Fictional meal note" }),
    ]);
    expect(allowed.body).not.toContain("prompt");
    expect(allowed.body).not.toContain("secret");

    const missing = await application.inject({
      method: "GET",
      url: "/api/v1/conversation-compressions/00000000-0000-4000-8000-000000000099/content",
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("allows provider changes after login and audits the outcome", async () => {
    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const cookie = login.headers["set-cookie"];
    const provider = {
      name: "Preview provider",
      apiKind: "chat-completions",
      baseUrl: "https://ai.example.test/v1/",
      model: "fictional-model",
      secret: "sk-preview-provider",
    };

    const created = await application.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      headers: { cookie },
      payload: provider,
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain("sk-preview-provider");
    expect(authRepository.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "ai.provider.create",
          outcome: "succeeded",
        }),
      ]),
    );
  });

  it("revokes the server session on logout", async () => {
    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const cookie = login.headers["set-cookie"];
    const logout = await application.inject({
      method: "DELETE",
      url: "/api/v1/auth/session",
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");

    const session = await application.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie },
    });
    expect(session.statusCode).toBe(401);
  });
});
