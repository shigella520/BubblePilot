import { AgentSettingsService } from "../modules/ai/agent-settings-service.js";
import { InMemoryAgentSettingsRepository } from "./support/in-memory-agent-settings-repository.js";
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
import { ContextSettingsService } from "../modules/workflow/context-settings-service.js";
import type { MessageAutomation } from "../modules/workflow/workflow-engine.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";
import { InMemoryArchiveRepository } from "./support/in-memory-archive-repository.js";
import { InMemoryAuthRepository } from "./support/in-memory-auth-repository.js";
import { InMemoryWorkflowRepository } from "./support/in-memory-workflow-repository.js";

const loginPassword = "fictional-login-password";
const sensitivePassword = "fictional-sensitive-password";
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
  let archiveRepository: InMemoryArchiveRepository;
  let aiRepository: InMemoryAiRepository;

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
    aiRepository = new InMemoryAiRepository();
    archiveRepository = new InMemoryArchiveRepository();
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
      closeRecoveryQueue: () => Promise.resolve({ closedCount: 0 }),
      runtimeStatus: () => ({
        active: 0,
        queued: 0,
        maxConcurrency: 4,
        queueCapacity: 64,
      }),
    };
    application = buildApplication(config, archiveRepository, {
      logger: false,
      auth: new AuthService(authRepository, {
        loginPasswordHash,
        sensitiveOperationPasswordHash,
        sessionTtlSeconds: config.adminSessionTtlSeconds,
        sensitiveOperationTtlSeconds: config.sensitiveOperationTtlSeconds,
      }),
      ai: {
        repository: aiRepository,
        agentSettings: new AgentSettingsService(
          new InMemoryAgentSettingsRepository(),
        ),
        management: new AiManagementService(
          aiRepository,
          new SuccessfulAiClient(),
          secrets,
        ),
        contextSettings: new ContextSettingsService(
          {
            isReady: () => Promise.resolve(true),
            find: () =>
              Promise.resolve({
                includeFromMe: true,
                baseMessageWindow: 30,
                characterLimit: 6_000,
                redundancyMessageWindow: 10,
                version: 1,
                updatedAt: "2026-09-08T00:00:00.000Z",
              }),
            save: () => Promise.resolve({ status: "conflict" as const }),
          },
          {
            includeFromMe: true,
            baseMessageWindow: 30,
            characterLimit: 6_000,
            redundancyMessageWindow: 10,
          },
        ),
      },
      workflow: {
        repository: workflowRepository,
        engine: workflowEngine,
      },
    });
  });

  afterEach(async () => {
    await application.close();
  });

  it("protects scheduled task changes and request snapshots with step-up", async () => {
    expect(
      (
        await application.inject({
          method: "GET",
          url: "/api/v1/scheduled-tasks",
        })
      ).statusCode,
    ).toBe(401);
    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const headers = {
      cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      origin: "http://localhost",
    };
    for (const method of ["GET", "PATCH", "DELETE"] as const)
      expect(
        (
          await application.inject({
            method,
            url: "/api/v1/scheduled-tasks/00000000-0000-4000-8000-000000000001",
            headers,
            ...(method === "PATCH"
              ? { payload: { expectedVersion: 1, content: "fixture" } }
              : {}),
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (
        await application.inject({
          method: "POST",
          url: "/api/v1/scheduled-tasks/00000000-0000-4000-8000-000000000001/cancel",
          headers,
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(403);
    for (const operation of ["pause", "resume", "skip-next"]) {
      expect(
        (
          await application.inject({
            method: "POST",
            url: `/api/v1/scheduled-tasks/00000000-0000-4000-8000-000000000001/${operation}`,
            headers,
            payload: { expectedVersion: 1 },
          })
        ).statusCode,
      ).toBe(403);
    }
    const previewBody = {
      timeZone: "UTC",
      consumedCount: 1,
      schedule: {
        kind: "recurring",
        startsAt: new Date(Date.now() + 3600000).toISOString(),
        rule: { type: "interval", everyMinutes: 60 },
        end: { kind: "count", count: 2 },
      },
    };
    expect(
      (
        await application.inject({
          method: "POST",
          url: "/api/v1/scheduled-tasks/preview",
          payload: previewBody,
        })
      ).statusCode,
    ).toBe(401);
    const preview = await application.inject({
      method: "POST",
      url: "/api/v1/scheduled-tasks/preview",
      headers,
      payload: previewBody,
    });
    expect(preview.statusCode).toBe(200);
    expect(
      preview.json<{ data: { upcoming: string[] } }>().data.upcoming,
    ).toHaveLength(1);
    expect(
      (
        await application.inject({
          method: "PUT",
          url: "/api/v1/settings/scheduled-tasks",
          headers,
          payload: {
            paused: false,
            pendingLimit: 1000,
            catchupMinutes: 30,
            expectedVersion: 1,
          },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("allows member mapping reads and changes after login without step-up and retains audit", async () => {
    const chatGuid = "iMessage;-;fictional-member-chat";
    for (const messageGuid of ["fictional-discovery", "fictional-archived"]) {
      const webhook = await application.inject({
        method: "POST",
        url: "/api/v1/webhooks/bluebubbles",
        headers: {
          "x-bubblepilot-webhook-secret":
            "fictional-webhook-secret-32-chars-long",
        },
        payload: newMessageWebhook({ chatGuid, messageGuid }),
      });
      expect(webhook.statusCode).toBe(202);
      if (messageGuid === "fictional-discovery") {
        const chat = archiveRepository.chats.get(chatGuid);
        if (!chat) throw new Error("Chat fixture not discovered");
        const enabled = await archiveRepository.setChatMonitoring({
          chatId: chat.id,
          enabled: true,
          expectedVersion: chat.version,
        });
        expect(enabled.status).toBe("ok");
      }
    }
    const chat = archiveRepository.chats.get(chatGuid);
    if (!chat) throw new Error("Chat fixture unavailable");
    const url = `/api/v1/chats/${chat.id}/participants`;
    const payload = {
      expectedVersion: 1,
      identities: [
        {
          senderId: "fictional-user@example.test",
          realName: "虚构成员",
          nickname: "虚构昵称",
        },
      ],
    };
    expect((await application.inject({ method: "GET", url })).statusCode).toBe(
      401,
    );
    expect(
      (await application.inject({ method: "PUT", url, payload })).statusCode,
    ).toBe(401);
    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const headers = {
      cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      origin: "http://localhost",
    };
    const before = await application.inject({ method: "GET", url, headers });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      data: {
        version: 1,
        participants: [{ senderId: "fictional-user@example.test" }],
      },
    });
    const saved = await application.inject({
      method: "PUT",
      url,
      headers,
      payload,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      data: {
        version: 2,
        participants: [{ realName: "虚构成员", nickname: "虚构昵称" }],
      },
    });
    expect(authRepository.grants.size).toBe(0);
    for (const action of ["chat.participants.view", "chat.participants.update"])
      expect(authRepository.auditEvents).toContainEqual(
        expect.objectContaining({
          action,
          targetId: chat.id,
          outcome: "succeeded",
        }),
      );
    expect(JSON.stringify(authRepository.auditEvents)).not.toContain(
      "虚构成员",
    );
    expect(JSON.stringify(authRepository.auditEvents)).not.toContain(
      "虚构昵称",
    );
    expect(
      (await application.inject({ method: "PUT", url, headers, payload }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await application.inject({
          method: "GET",
          url: `/api/v1/chats/${chat.id}/messages`,
          headers,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("allows signed-in workflow imports without step-up and retains audit and unpublished candidate state", async () => {
    const manifest = {
      kind: "BubblePilotWorkflow",
      apiVersion: "bubblepilot.io/v1",
      metadata: { name: "Fictional signed-in import", description: "" },
      spec: {
        maxSteps: 1,
        startNodeId: "done",
        nodes: [
          {
            id: "done",
            type: "end",
            version: 1,
            config: { result: "succeeded" },
          },
        ],
      },
      bindings: { aiRoutes: {}, chats: {} },
    };
    const url = "/api/v1/workflows/import";
    expect(
      (await application.inject({ method: "POST", url, payload: {} }))
        .statusCode,
    ).toBe(401);
    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const headers = {
      cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      origin: "http://localhost",
    };
    const preview = await application.inject({
      method: "POST",
      url: `${url}/preview`,
      headers,
      payload: { manifest },
    });
    expect(preview.statusCode).toBe(200);
    const previewToken = preview.json<{ data: { previewToken: string } }>().data
      .previewToken;
    const created = await application.inject({
      method: "POST",
      url,
      headers,
      payload: { manifest, previewToken, mode: "create" },
    });
    expect(created.statusCode).toBe(201);
    const imported = created.json<{
      data: { workflowId: string; workflowVersion: number; status: string };
    }>().data;
    expect(imported.status).toBe("validated");
    const nextVersion = await application.inject({
      method: "POST",
      url,
      headers,
      payload: {
        manifest,
        previewToken,
        mode: "new-version",
        targetWorkflowId: imported.workflowId,
      },
    });
    expect(nextVersion.statusCode).toBe(201);
    expect(authRepository.grants.size).toBe(0);
    expect(
      authRepository.auditEvents.filter(
        (e) => e.action === "workflow.import" && e.outcome === "succeeded",
      ),
    ).toHaveLength(2);
    const workflows = await application.inject({
      method: "GET",
      url: "/api/v1/workflows",
      headers,
    });
    expect(
      workflows.json<{
        data: Array<{
          id: string;
          status: string;
          publishedVersion: number | null;
        }>;
      }>().data,
    ).toContainEqual(
      expect.objectContaining({
        id: imported.workflowId,
        status: "draft",
        publishedVersion: null,
      }),
    );
  });

  it.each(["idle", "scheduled"] as const)(
    "allows authenticated %s workflow management without step-up and keeps validations and audits",
    async (kind) => {
      const provider = await aiRepository.createProvider({
        name: "Fictional workflow provider",
        apiKind: "chat-completions",
        baseUrl: "https://ai.example.test/v1",
        model: "fictional-model",
        secretRef: "PREVIEW_AI_KEY",
        parameters: {},
        requestTimeoutMs: 5_000,
        enabled: true,
        capabilities: { functionCalling: true, hostedWebSearch: false },
      });
      if (provider.status !== "ok") throw new Error("Provider fixture failed");
      await aiRepository.updateProviderCapabilityProbe(provider.value.id, {
        functionCalling: "verified",
        hostedWebSearch: "unknown",
        checkedAt: new Date(0).toISOString(),
      });
      const route = await aiRepository.createRoute({
        name: "Fictional workflow route",
        providerIds: [provider.value.id],
        fallbackEnabled: true,
        retryPolicy: { maxRounds: 1, initialDelayMs: 0 },
        degradePolicy: { failureThreshold: 3, cooldownMs: 60_000 },
        enabled: true,
      });
      if (route.status !== "ok") throw new Error("Route fixture failed");
      const chatId = "fictional-workflow-chat";
      const definition = {
        schemaVersion: "1",
        name: "Fictional proactive workflow",
        startNodeId: "message-trigger",
        nodes: [
          {
            id: "message-trigger",
            type: "message-trigger",
            version: 1,
            config: {
              [kind]: { enabled: true, chatIds: [chatId], timeZone: "UTC" },
            },
            onSuccess: "ai",
          },
          {
            id: "ai",
            type: "ai-chat",
            version: 1,
            config: {
              providerRouteId: route.value.id,
              systemPrompt: "Fictional role",
              promptTemplate: "Respond naturally",
              outputVariable: "answer",
              outputFormat: "text",
            },
            onSuccess: "reply",
          },
          {
            id: "reply",
            type: "reply",
            version: 1,
            config: { text: "{{variables.answer}}" },
            onSuccess: "end",
          },
          { id: "end", type: "end", version: 1, config: {} },
        ],
      };
      const login = await application.inject({
        method: "POST",
        url: "/api/v1/auth/session",
        payload: { password: loginPassword },
      });
      const headers = {
        cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        origin: "http://localhost",
      };
      const created = await application.inject({
        method: "POST",
        url: "/api/v1/workflows",
        headers,
        payload: { name: definition.name, definition },
      });
      expect(created.statusCode).toBe(201);
      const workflowId = created.json<{ data: { workflowId: string } }>().data
        .workflowId;
      const publishUrl = `/api/v1/workflows/${workflowId}/versions/1/publish`;
      const blocked = await application.inject({
        method: "POST",
        url: publishUrl,
        headers,
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({
        error: {
          code:
            kind === "idle" ? "IDLE_CHAT_UNAVAILABLE" : "TASK_CHAT_UNAVAILABLE",
        },
      });
      archiveRepository.chats.set(chatId, {
        id: "00000000-0000-4000-8000-000000000001",
        providerChatId: chatId,
        type: "group",
        displayName: "Fictional chat",
        enabled: true,
        memoryAuthorized: false,
        messageCount: 0,
        version: 1,
        updatedAt: new Date(0).toISOString(),
        deletedAt: null,
        messages: [],
        participantIdentityVersion: 1,
        participantIdentities: new Map(),
      });
      expect(
        (await application.inject({ method: "POST", url: publishUrl, headers }))
          .statusCode,
      ).toBe(200);
      const revisedDefinition = {
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.id === "ai"
            ? {
                ...node,
                config: {
                  ...node.config,
                  systemPrompt: "Updated fictional role",
                },
              }
            : node,
        ),
      };
      const next = await application.inject({
        method: "POST",
        url: `/api/v1/workflows/${workflowId}/versions`,
        headers,
        payload: { definition: revisedDefinition },
      });
      expect(next.statusCode).toBe(201);
      const published = await application.inject({
        method: "POST",
        url: `/api/v1/workflows/${workflowId}/versions/2/publish`,
        headers,
      });
      expect(published.statusCode).toBe(200);
      const publishedNodes = published.json<{
        data: {
          definition: {
            nodes: Array<{ id: string; config: { systemPrompt?: string } }>;
          };
        };
      }>().data.definition.nodes;
      expect(
        publishedNodes.find((node) => node.id === "ai")?.config.systemPrompt,
      ).toBe("Updated fictional role");
      const enabledUrl = `/api/v1/workflows/${workflowId}/enabled`;
      for (const enabled of [false, true])
        expect(
          (
            await application.inject({
              method: "PATCH",
              url: enabledUrl,
              headers,
              payload: { enabled },
            })
          ).statusCode,
        ).toBe(200);
      const triggerPayload = {
        name: "Fictional extra trigger",
        workflowId,
        workflowVersion: 2,
        enabled: true,
        conditions: { chatIds: [chatId] },
      };
      const trigger = await application.inject({
        method: "POST",
        url: "/api/v1/triggers",
        headers,
        payload: triggerPayload,
      });
      expect(trigger.statusCode).toBe(201);
      const triggerId = trigger.json<{ data: { id: string } }>().data.id;
      const triggerUrl = `/api/v1/triggers/${triggerId}`;
      for (const enabled of [false, true])
        expect(
          (
            await application.inject({
              method: "PATCH",
              url: triggerUrl,
              headers,
              payload: { enabled },
            })
          ).statusCode,
        ).toBe(200);
      const exportUrl = `/api/v1/workflows/${workflowId}/versions/2/export?mode=instance-bound`;
      const exported = await application.inject({
        method: "GET",
        url: exportUrl,
        headers,
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.body).toContain(route.value.id);
      expect(exported.body).toContain(chatId);
      expect(exported.body).not.toContain("fictional-server-secret");
      expect(authRepository.grants.size).toBe(0);
      for (const request of [
        { method: "POST" as const, url: publishUrl },
        {
          method: "PATCH" as const,
          url: enabledUrl,
          payload: { enabled: true },
        },
        {
          method: "POST" as const,
          url: "/api/v1/triggers",
          payload: triggerPayload,
        },
        {
          method: "PATCH" as const,
          url: triggerUrl,
          payload: { enabled: true },
        },
        { method: "GET" as const, url: exportUrl },
      ])
        expect((await application.inject(request)).statusCode).toBe(401);
      expect(
        (
          await application.inject({
            method: "PUT",
            url: triggerUrl,
            headers,
            payload: {
              name: "Updated fictional trigger",
              conditions: { chatIds: [chatId] },
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await application.inject({
            method: "DELETE",
            url: triggerUrl,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await application.inject({
            method: "DELETE",
            url: `/api/v1/workflows/${workflowId}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      for (const action of [
        "workflow.create",
        "workflow.version.create",
        "workflow.enabled.update",
        "workflow.delete",
        "workflow.idle.publish",
        "workflow.idle.enable",
        "workflow.idle.trigger.create",
        "workflow.idle.trigger.enable",
        "trigger.update",
        "trigger.delete",
        "workflow.export",
      ])
        expect(authRepository.auditEvents).toContainEqual(
          expect.objectContaining({ action, outcome: "succeeded" }),
        );
      expect(authRepository.auditEvents).toContainEqual(
        expect.objectContaining({
          action: "workflow.idle.publish",
          outcome: "failed",
        }),
      );
    },
  );

  it("requires sensitive authorization and audits bulk recovery closure", async () => {
    const url = "/api/v1/executions/recovery/close";
    expect((await application.inject({ method: "POST", url })).statusCode).toBe(
      401,
    );
    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const headers = { cookie, origin: "http://localhost" };
    expect(
      (await application.inject({ method: "POST", url, headers })).statusCode,
    ).toBe(403);
    expect(authRepository.auditEvents).toContainEqual(
      expect.objectContaining({
        action: "execution.bulk-close",
        outcome: "denied",
      }),
    );
    const unlock = await application.inject({
      method: "POST",
      url: "/api/v1/auth/sensitive",
      headers,
      payload: { password: sensitivePassword },
    });
    expect(unlock.statusCode).toBe(200);
    const result = await application.inject({ method: "POST", url, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ data: { closedCount: 0 } });
    expect(authRepository.auditEvents).toContainEqual(
      expect.objectContaining({
        action: "execution.bulk-close",
        outcome: "succeeded",
      }),
    );
  });

  it("protects execution image previews and source text with login and step-up", async () => {
    const base =
      "/api/v1/executions/11111111-1111-4111-8111-111111111111/image-inputs/22222222-2222-4222-8222-222222222222";
    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    for (const suffix of ["preview", "source"]) {
      expect(
        (await application.inject({ method: "GET", url: `${base}/${suffix}` }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await application.inject({
            method: "GET",
            url: `${base}/${suffix}`,
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(403);
    }
    await application.inject({
      method: "POST",
      url: "/api/v1/auth/sensitive",
      headers: { cookie },
      payload: { password: sensitivePassword },
    });
    expect(
      (
        await application.inject({
          method: "GET",
          url: `${base}/preview`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("audits Agent settings updates without requiring a sensitive-operation unlock", async () => {
    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const saved = await application.inject({
      method: "PUT",
      url: "/api/v1/ai/agent/settings",
      headers: { cookie, origin: "http://localhost" },
      payload: {
        maxToolCalls: 10,
        maxToolOutputCharacters: 24000,
        maxToolDurationMs: 60000,
        expectedVersion: 0,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(authRepository.auditEvents).toContainEqual(
      expect.objectContaining({
        action: "ai.agent.settings.update",
        outcome: "succeeded",
      }),
    );
  });
  it("protects context settings, validates limits and audits concurrent-save conflicts", async () => {
    expect(
      (
        await application.inject({
          method: "GET",
          url: "/api/v1/ai/context/settings",
        })
      ).statusCode,
    ).toBe(401);
    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const headers = { cookie, origin: "http://localhost" };
    const payload = {
      includeFromMe: true,
      baseMessageWindow: 10,
      redundancyMessageWindow: 10,
      characterLimit: 6000,
      expectedVersion: 1,
    };
    expect(
      (
        await application.inject({
          method: "GET",
          url: "/api/v1/ai/context/settings",
          headers,
        })
      ).statusCode,
    ).toBe(200);
    for (const invalid of [
      { baseMessageWindow: 0 },
      { redundancyMessageWindow: 51 },
      { characterLimit: 99 },
      { enabled: true },
    ]) {
      expect(
        (
          await application.inject({
            method: "PUT",
            url: "/api/v1/ai/context/settings",
            headers,
            payload: { ...payload, ...invalid },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await application.inject({
          method: "PUT",
          url: "/api/v1/ai/context/settings",
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(409);
    expect(authRepository.auditEvents).toContainEqual(
      expect.objectContaining({
        action: "ai.context.settings.update",
        outcome: "failed",
      }),
    );
    for (const path of [
      "/api/v1/ai/summary/settings",
      "/api/v1/conversation-compressions",
    ]) {
      expect(
        (await application.inject({ method: "GET", url: path, headers }))
          .statusCode,
      ).toBe(404);
    }
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
  it("requires sensitive verification on every memory content and mutation entry", async () => {
    const login = await application.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { password: loginPassword },
    });
    const cookie = login.headers["set-cookie"];
    const id = "00000000-0000-4000-8000-000000000001";
    const cases = [
      ["PUT", "/api/v1/ai/memory/settings"],
      ["POST", "/api/v1/ai/memory/probe"],
      ["PUT", `/api/v1/chats/${id}/memory`],
      ["POST", `/api/v1/chats/${id}/memory/search`],
      ["POST", `/api/v1/chats/${id}/memory/jobs`],
      ["POST", `/api/v1/memory/jobs/${id}/actions`],
      ["GET", `/api/v1/memory/retrievals/${id}/sources/M1`],
    ] as const;
    for (const [method, url] of cases) {
      const response = await application.inject({
        method,
        url,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: "SENSITIVE_AUTH_REQUIRED" },
      });
    }
  });
});
