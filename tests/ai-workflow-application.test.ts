import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../app/application.js";
import type { AppConfig } from "../app/config.js";
import { AiManagementService } from "../modules/ai/ai-management-service.js";
import { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import type { AiClient } from "../modules/ai/openai-compatible-client.js";
import type {
  AiCallResult,
  AiChatRequest,
  AiProviderRecord,
} from "../modules/ai/ai-types.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import type {
  DeliveryResult,
  ReplyGateway,
  SendReplyCommand,
} from "../modules/integrations/bluebubbles/reply-gateway.js";
import { createDefaultNodeRegistry } from "../modules/workflow/node-registry.js";
import type { WorkflowDefinition } from "../modules/workflow/workflow-definition.js";
import { WorkflowEngine } from "../modules/workflow/workflow-engine.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";
import { InMemoryArchiveRepository } from "./support/in-memory-archive-repository.js";
import { InMemoryWorkflowRepository } from "./support/in-memory-workflow-repository.js";

const apiAccessToken = "fictional-api-access-token-32-chars-long";
const webhookSecret = "fictional-webhook-secret-32-chars-long";
const monitoredChatId = "iMessage;-;fictional-chat";
const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 8080,
  databaseUrl: "postgresql://unused.example.test/bubblepilot",
  apiAccessToken,
  loginPasswordHash: "scrypt$16384$8$1$fictional-salt$fictional-key",
  sensitiveOperationPasswordHash:
    "scrypt$16384$8$1$fictional-salt$fictional-key",
  adminSessionTtlSeconds: 43_200,
  sensitiveOperationTtlSeconds: 300,
  blueBubblesWebhookSecret: webhookSecret,
  blueBubblesServerUrl: "https://bluebubbles.example.test",
  blueBubblesAccessToken: "fictional-bluebubbles-token",
  blueBubblesSendMethod: "private-api",
  blueBubblesRequestTimeoutMs: 30_000,
  monitoredChatIds: new Set([monitoredChatId]),
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

class CapturingAiClient implements AiClient {
  readonly requests: AiChatRequest[] = [];

  call(
    _provider: AiProviderRecord,
    request: AiChatRequest,
  ): Promise<AiCallResult> {
    this.requests.push(structuredClone(request));
    return Promise.resolve({
      status: "succeeded",
      text: "Fictional AI answer",
      durationMs: 9,
    });
  }
}

class CapturingReplyGateway implements ReplyGateway {
  readonly commands: SendReplyCommand[] = [];

  sendReply(command: SendReplyCommand): Promise<DeliveryResult> {
    this.commands.push(command);
    return Promise.resolve({
      status: "confirmed",
      providerMessageId: "fictional-outbound-message",
    });
  }
}

describe("AI workflow", () => {
  let archive: InMemoryArchiveRepository;
  let workflows: InMemoryWorkflowRepository;
  let aiRepository: InMemoryAiRepository;
  let aiClient: CapturingAiClient;
  let replyGateway: CapturingReplyGateway;
  let application: FastifyInstance;
  let routeId: string;

  beforeEach(async () => {
    archive = new InMemoryArchiveRepository();
    workflows = new InMemoryWorkflowRepository();
    aiRepository = new InMemoryAiRepository();
    aiClient = new CapturingAiClient();
    replyGateway = new CapturingReplyGateway();
    const secrets = new EnvironmentSecretResolver({
      FICTIONAL_AI_KEY: "fictional-server-secret",
    });
    const provider = await aiRepository.createProvider({
      name: "Fictional AI",
      apiKind: "chat-completions",
      baseUrl: "https://ai.example.test/v1",
      model: "fictional-model",
      secretRef: "FICTIONAL_AI_KEY",
      parameters: {},
      requestTimeoutMs: 5_000,
      enabled: true,
    });
    if (provider.status !== "ok") {
      throw new Error("Provider fixture failed.");
    }
    const route = await aiRepository.createRoute({
      name: "Default route",
      providerIds: [provider.value.id],
      fallbackEnabled: true,
      retryPolicy: { maxRounds: 2, initialDelayMs: 0 },
      degradePolicy: { failureThreshold: 3, cooldownMs: 1_000 },
      enabled: true,
    });
    if (route.status !== "ok") {
      throw new Error("Route fixture failed.");
    }
    routeId = route.value.id;
    const routing = new AiRoutingService(aiRepository, aiClient, secrets);
    const engine = new WorkflowEngine(
      workflows,
      createDefaultNodeRegistry(workflows, replyGateway, {
        archive,
        aiRouting: routing,
      }),
    );
    application = buildApplication(config, archive, {
      logger: false,
      ai: {
        repository: aiRepository,
        management: new AiManagementService(aiRepository, aiClient, secrets),
      },
      workflow: { repository: workflows, engine },
    });
  });

  afterEach(async () => {
    await application.close();
  });

  it("loads bounded history, maps variables, calls AI, and replies once", async () => {
    const definition = {
      schemaVersion: "1",
      name: "ask-ai",
      startNodeId: "load-history",
      maxSteps: 8,
      maxExecutionMs: 10_000,
      nodes: [
        {
          id: "load-history",
          type: "load-context",
          version: 1,
          config: {
            messageLimit: 5,
            characterLimit: 1_000,
            includeFromMe: true,
          },
          onSuccess: "map-question",
          onFailure: "failed",
        },
        {
          id: "map-question",
          type: "set-variable",
          version: 1,
          config: {
            name: "question",
            valueTemplate: "{{message.text}}",
          },
          onSuccess: "ask-ai",
        },
        {
          id: "ask-ai",
          type: "ai-chat",
          version: 1,
          config: {
            providerRouteId: routeId,
            systemPrompt: "Answer safely for {{message.senderId}}.",
            promptTemplate: "Question: {{variables.question}}",
            includeLoadedContext: true,
            timeoutMs: 5_000,
            maxOutputTokens: 256,
            maxOutputCharacters: 2_000,
            temperature: 0.2,
            outputFormat: "text",
            outputVariable: "aiReply",
          },
          onSuccess: "reply",
          onFailure: "failed",
        },
        {
          id: "reply",
          type: "reply",
          version: 1,
          config: {
            text: "{{variables.aiReply}}",
            replyToSourceMessage: true,
            retry: { maxAttempts: 1, initialDelayMs: 0 },
          },
          onSuccess: "done",
        },
        {
          id: "failed",
          type: "end",
          version: 1,
          config: { result: "skipped" },
        },
        {
          id: "done",
          type: "end",
          version: 1,
          config: { result: "succeeded" },
        },
      ],
    } satisfies WorkflowDefinition;
    const created = await application.inject({
      method: "POST",
      url: "/api/v1/workflows",
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: { name: "Ask AI", definition },
    });
    expect(created.statusCode).toBe(201);
    const workflow = created.json<{
      data: { workflowId: string; version: number };
    }>().data;
    const published = await application.inject({
      method: "POST",
      url: `/api/v1/workflows/${workflow.workflowId}/versions/${workflow.version}/publish`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(published.statusCode).toBe(200);
    const trigger = await application.inject({
      method: "POST",
      url: "/api/v1/triggers",
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: {
        name: "Ask command",
        workflowId: workflow.workflowId,
        workflowVersion: workflow.version,
        enabled: true,
        conditions: {
          chatIds: [monitoredChatId],
          senderIds: [],
          contentTypes: ["text"],
          text: { kind: "prefix", value: "/ask", caseSensitive: false },
        },
      },
    });
    expect(trigger.statusCode).toBe(201);

    await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "fictional-history",
        text: "Earlier fictional context",
      }),
    });
    const incoming = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "fictional-question",
        text: "/ask what happened?",
      }),
    });
    expect(incoming.statusCode).toBe(202);
    const executionId = incoming.json<{ data: { executionIds: string[] } }>()
      .data.executionIds[0];
    expect(executionId).toBeDefined();
    expect(aiClient.requests).toHaveLength(1);
    expect(aiClient.requests[0]?.messages).toEqual([
      {
        role: "system",
        content: "Answer safely for fictional-user@example.test.",
      },
      {
        role: "user",
        content: "[fictional-user@example.test] Earlier fictional context",
      },
      { role: "user", content: "Question: /ask what happened?" },
    ]);
    expect(replyGateway.commands).toMatchObject([
      {
        text: "Fictional AI answer",
        replyToProviderMessageId: "fictional-question",
      },
    ]);

    const detail = await application.inject({
      method: "GET",
      url: `/api/v1/executions/${executionId}`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      data: {
        status: "succeeded",
        aiProviderAttempts: [
          {
            nodeId: "ask-ai",
            round: 1,
            sequence: 1,
            status: "succeeded",
            routeVersion: 1,
            providerVersion: 1,
            selectionHealthState: "healthy",
            healthState: "healthy",
            errorCategory: null,
          },
        ],
      },
    });
    expect(detail.body).not.toContain("fictional-server-secret");
    expect(detail.body).not.toContain("Earlier fictional context");
    expect(detail.body).not.toContain("Fictional AI answer");
  });

  it("rejects publishing a workflow whose AI route is unavailable", async () => {
    const definition = {
      schemaVersion: "1",
      name: "missing-route",
      startNodeId: "ask-ai",
      maxSteps: 4,
      maxExecutionMs: 5_000,
      nodes: [
        {
          id: "ask-ai",
          type: "ai-chat",
          version: 1,
          config: {
            providerRouteId: "22222222-2222-4222-8222-222222222222",
            systemPrompt: "",
            promptTemplate: "Fictional prompt",
            includeLoadedContext: false,
            timeoutMs: 5_000,
            maxOutputTokens: 128,
            maxOutputCharacters: 2_000,
            temperature: null,
            outputFormat: "text",
            outputVariable: "aiReply",
          },
          onSuccess: "done",
          onFailure: "done",
        },
        {
          id: "done",
          type: "end",
          version: 1,
          config: { result: "succeeded" },
        },
      ],
    } satisfies WorkflowDefinition;
    const created = await application.inject({
      method: "POST",
      url: "/api/v1/workflows",
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: { name: "Missing route", definition },
    });
    expect(created.statusCode).toBe(201);
    const workflow = created.json<{
      data: { workflowId: string; version: number };
    }>().data;
    const published = await application.inject({
      method: "POST",
      url: `/api/v1/workflows/${workflow.workflowId}/versions/${workflow.version}/publish`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(published.statusCode).toBe(409);
    expect(published.json()).toMatchObject({
      error: { code: "AI_ROUTE_NOT_PUBLISHABLE" },
    });
  });
});
