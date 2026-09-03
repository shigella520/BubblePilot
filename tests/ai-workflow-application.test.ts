import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../app/application.js";
import type { AppConfig } from "../app/config.js";
import { AiManagementService } from "../modules/ai/ai-management-service.js";
import { AiRawRequestStore } from "../modules/ai/ai-raw-request-store.js";
import { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import {
  OpenAiCompatibleClient,
  type AiClient,
} from "../modules/ai/openai-compatible-client.js";
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
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
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
  databaseQueryTimeoutMs: 30_000,
  apiAccessToken,
  settingsEncryptionKey: "fictional-settings-encryption-key-32-chars",
  loginPasswordHash: "scrypt$16384$8$1$fictional-salt$fictional-key",
  sensitiveOperationPasswordHash:
    "scrypt$16384$8$1$fictional-salt$fictional-key",
  adminSessionTtlSeconds: 43_200,
  sensitiveOperationTtlSeconds: 300,
  sessionCookieSecure: "auto",
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

  private readonly delegate: OpenAiCompatibleClient;

  constructor(
    secrets: EnvironmentSecretResolver,
    rawRequestStore?: AiRawRequestStore,
  ) {
    this.delegate = new OpenAiCompatibleClient(
      secrets,
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  message: { content: "Fictional AI answer" },
                },
              ],
              usage: {
                prompt_tokens: 120,
                completion_tokens: 8,
                total_tokens: 128,
                prompt_tokens_details: { cached_tokens: 64 },
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        ),
      rawRequestStore,
    );
  }

  call(
    provider: AiProviderRecord,
    request: AiChatRequest,
  ): Promise<AiCallResult> {
    this.requests.push(structuredClone(request));
    return this.delegate.call(provider, request);
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

function sharedMessagePrefixLength(
  left: readonly AiChatRequest["messages"][number][],
  right: readonly AiChatRequest["messages"][number][],
): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (
    index < limit &&
    JSON.stringify(left[index]) === JSON.stringify(right[index])
  ) {
    index += 1;
  }
  return index;
}

describe("AI workflow", () => {
  let archive: InMemoryArchiveRepository;
  let workflows: InMemoryWorkflowRepository;
  let aiRepository: InMemoryAiRepository;
  let aiClient: CapturingAiClient;
  let replyGateway: CapturingReplyGateway;
  let rawRequestStore: AiRawRequestStore;
  let application: FastifyInstance;
  let routeId: string;

  beforeEach(async () => {
    archive = new InMemoryArchiveRepository();
    workflows = new InMemoryWorkflowRepository();
    aiRepository = new InMemoryAiRepository();
    replyGateway = new CapturingReplyGateway();
    rawRequestStore = new AiRawRequestStore(20);
    const secrets = new EnvironmentSecretResolver({
      FICTIONAL_AI_KEY: "fictional-server-secret",
    });
    aiClient = new CapturingAiClient(secrets, rawRequestStore);
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
      { timeZone: "Asia/Shanghai" },
    );
    application = buildApplication(config, archive, {
      logger: false,
      ai: {
        repository: aiRepository,
        management: new AiManagementService(aiRepository, aiClient, secrets),
        rawRequestStore,
      },
      workflow: { repository: workflows, engine },
    });
  });

  afterEach(async () => {
    await application.close();
  });

  it("labels conversation members once and keeps chained AI output distinct", async () => {
    const definition = {
      schemaVersion: "1",
      name: "ask-ai",
      startNodeId: "load-history",
      maxSteps: 8,
      nodes: [
        {
          id: "load-history",
          type: "load-context",
          version: 1,
          config: {},
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
            maxOutputTokens: 256,
            maxOutputCharacters: 2_000,
            temperature: 0.2,
            webSearchSources: "full",
            outputFormat: "text",
            outputVariable: "aiReply",
          },
          inputs: {
            messages: {
              kind: "output",
              blockId: "load-history",
              port: "messages",
            },
            prompt: { kind: "path", path: "context.event.message.text" },
          },
          onSuccess: "refine-ai",
          onFailure: "failed",
        },
        {
          id: "refine-ai",
          type: "ai-chat",
          version: 1,
          config: {
            providerRouteId: routeId,
            systemPrompt: "Polish the upstream draft.",
            promptTemplate: "Return a concise final answer.",
            includeLoadedContext: false,
            maxOutputTokens: 256,
            maxOutputCharacters: 2_000,
            temperature: 0.2,
            webSearchSources: "full",
            outputFormat: "text",
            outputVariable: "finalReply",
          },
          inputs: {
            prompt: {
              kind: "output",
              blockId: "ask-ai",
              port: "text",
            },
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
          inputs: {
            text: { kind: "output", blockId: "refine-ai", port: "text" },
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
        messageGuid: "fictional-outside-history",
        text: "Older context outside the loaded window",
        senderAddress: "outside-user@example.test",
      }),
    });
    await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "fictional-history",
        text: "Earlier fictional context https://public.example.test/article",
      }),
    });
    await archive.saveMessageLinkPreview({
      providerMessageId: "fictional-history",
      linkPreview: {
        status: "available",
        errorCode: null,
        items: [
          {
            source: "bluebubbles",
            url: "https://public.example.test/article",
            originalUrl: null,
            title: "Fictional article",
            summary: "Fictional summary",
            siteName: "Example Test",
            imageAvailable: true,
            imageUrl: null,
            imageSource: null,
            iconAvailable: false,
          },
        ],
      },
      diagnostics: [],
      fetchedAt: new Date("2026-08-29T10:40:01.000Z"),
    });
    await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "fictional-bot-history",
        text: "Earlier fictional Bot reply",
        isFromMe: true,
      }),
    });
    await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "fictional-other-history",
        text: "Another participant context",
        senderAddress: "another-user@example.test",
      }),
    });
    const chat = archive.chats.get(monitoredChatId);
    expect(chat).toBeDefined();
    await expect(
      archive.saveChatParticipantIdentities({
        chatId: chat?.id ?? "",
        expectedVersion: 1,
        identities: [
          {
            senderId: "fictional-user@example.test",
            realName: "林一",
            nickname: "队长",
          },
          {
            senderId: "another-user@example.test",
            realName: "周二",
            nickname: "二号",
          },
          {
            senderId: "outside-user@example.test",
            realName: "陈三",
            nickname: "三号",
          },
        ],
      }),
    ).resolves.toMatchObject({ status: "ok" });
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
    expect(aiClient.requests).toHaveLength(2);
    const firstMessages = aiClient.requests[0]?.messages ?? [];
    expect(firstMessages[0]?.role).toBe("system");
    expect(firstMessages[0]?.content).toContain("BubblePilot 输入协议");
    expect(firstMessages[0]?.content).toContain("<ai_system>");
    const serializedFirstMessages = JSON.stringify(firstMessages);
    expect(serializedFirstMessages).toContain(
      'sender_id=\\"fictional-user@example.test\\"',
    );
    expect(serializedFirstMessages).toContain("<participant_identities>");
    expect(
      serializedFirstMessages.indexOf("Earlier fictional context"),
    ).toBeLessThan(serializedFirstMessages.indexOf("<participant_identities>"));
    expect(aiClient.requests[1]?.messages).toEqual([
      {
        role: "system",
        content: "<ai_system>Polish the upstream draft.</ai_system>",
      },
      {
        role: "user",
        content:
          "<static_task>\nReturn a concise final answer.\n</static_task>",
      },
      {
        role: "user",
        content:
          '<upstream_input source="ask-ai.text">\nFictional AI answer\n</upstream_input>',
      },
    ]);
    // Node-level message limits are no longer applied; the global context
    // reader owns retention and includes the complete historical increment.
    expect(JSON.stringify(aiClient.requests)).toContain(
      "outside-user@example.test",
    );
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
            rawRequest: { status: "available" },
          },
          {
            nodeId: "refine-ai",
            round: 1,
            sequence: 1,
            status: "succeeded",
            routeVersion: 1,
            providerVersion: 1,
            selectionHealthState: "healthy",
            healthState: "healthy",
            errorCategory: null,
            rawRequest: { status: "available" },
          },
        ],
      },
    });
    expect(detail.body).not.toContain("fictional-server-secret");
    expect(detail.body).not.toContain("Earlier fictional context");
    expect(detail.body).not.toContain("Fictional AI answer");

    const firstAttemptId = detail.json<{
      data: { aiProviderAttempts: Array<{ id: string }> };
    }>().data.aiProviderAttempts[0]?.id;
    const rawRequest = await application.inject({
      method: "GET",
      url: `/api/v1/executions/${executionId}/ai-attempts/${firstAttemptId}/raw-request`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(rawRequest.statusCode).toBe(200);
    const rawRequestBody = rawRequest.json<{
      data: { attemptId: string; body: string };
    }>();
    expect(rawRequestBody.data.attemptId).toBe(firstAttemptId);
    expect(rawRequestBody.data.body).toContain("Earlier fictional context");
    expect(rawRequest.body).not.toContain("fictional-server-secret");
  });

  it("keeps each complete text-turn prompt as the next turn's exact prefix", async () => {
    const definition = {
      schemaVersion: "1",
      name: "cache-prefix",
      startNodeId: "load-history",
      maxSteps: 4,
      nodes: [
        {
          id: "load-history",
          type: "load-context",
          version: 1,
          config: {},
          onSuccess: "ask-ai",
          onFailure: "done",
        },
        {
          id: "ask-ai",
          type: "ai-chat",
          version: 1,
          config: {
            providerRouteId: routeId,
            systemPrompt: "Stable fictional system prompt.",
            promptTemplate: "Answer the latest fictional message.",
            includeLoadedContext: true,
            maxOutputTokens: 128,
            maxOutputCharacters: 1_000,
            temperature: 0,
            webSearchSources: "full",
            outputFormat: "text",
            outputVariable: "answer",
          },
          inputs: {
            messages: {
              kind: "output",
              blockId: "load-history",
              port: "messages",
            },
            prompt: { kind: "path", path: "context.event.message.text" },
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
      payload: { name: "Cache prefix", definition },
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
        name: "Cache command",
        workflowId: workflow.workflowId,
        workflowVersion: workflow.version,
        enabled: true,
        conditions: {
          chatIds: [monitoredChatId],
          senderIds: [],
          contentTypes: ["text"],
          text: { kind: "prefix", value: "/cache", caseSensitive: false },
        },
      },
    });
    expect(trigger.statusCode).toBe(201);

    await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "cache-history",
        text: "Stable earlier context",
      }),
    });
    await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "cache-turn-one",
        text: "/cache first turn",
      }),
    });
    await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "cache-bot-reply",
        text: "Stable fictional Bot reply",
        isFromMe: true,
      }),
    });
    await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "cache-turn-two",
        text: "/cache second turn",
      }),
    });
    await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "cache-bot-reply-two",
        text: "Second stable fictional Bot reply",
        isFromMe: true,
      }),
    });
    await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "cache-turn-three",
        text: "/cache third turn",
      }),
    });

    expect(aiClient.requests).toHaveLength(3);
    const first = aiClient.requests[0]?.messages ?? [];
    const second = aiClient.requests[1]?.messages ?? [];
    const third = aiClient.requests[2]?.messages ?? [];
    expect(sharedMessagePrefixLength(first, second)).toBe(first.length - 1);
    expect(sharedMessagePrefixLength(second, third)).toBe(second.length - 1);
    expect(second.length).toBeGreaterThan(first.length);
    expect(third.length).toBeGreaterThan(second.length);
    expect(JSON.stringify(aiClient.requests)).not.toContain("current_input");

    const traces = aiRepository.attempts
      .filter((attempt) => attempt.nodeId === "ask-ai")
      .map((attempt) => attempt.diagnostics?.requestTrace);
    expect(traces).toHaveLength(3);
    expect(traces[0]).toMatchObject({
      previousItemCount: null,
      sharedPrefixItemCount: null,
      previousRequestIsExactPrefix: null,
    });
    expect(traces[1]).toMatchObject({
      previousItemCount: first.length,
      sharedPrefixItemCount: first.length - 1,
      configurationMatchesPrevious: true,
      previousRequestIsExactPrefix: false,
    });
    expect(traces[2]).toMatchObject({
      previousItemCount: second.length,
      sharedPrefixItemCount: second.length - 1,
      configurationMatchesPrevious: true,
      previousRequestIsExactPrefix: false,
    });
  });

  it("does not leak messages archived after a queued trigger into its history", async () => {
    const definition = {
      schemaVersion: "1",
      name: "frozen-context-boundary",
      startNodeId: "load-history",
      maxSteps: 4,
      nodes: [
        {
          id: "load-history",
          type: "load-context",
          version: 1,
          config: {},
          onSuccess: "ask-ai",
          onFailure: "done",
        },
        {
          id: "ask-ai",
          type: "ai-chat",
          version: 1,
          config: {
            providerRouteId: routeId,
            systemPrompt: "Stable fictional system prompt.",
            promptTemplate: "Inspect the frozen history.",
            includeLoadedContext: true,
            maxOutputTokens: 128,
            maxOutputCharacters: 1_000,
            temperature: 0,
            webSearchSources: "full",
            outputFormat: "text",
            outputVariable: "answer",
          },
          inputs: {
            messages: {
              kind: "output",
              blockId: "load-history",
              port: "messages",
            },
            prompt: { kind: "path", path: "context.event.message.text" },
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
    const created = await workflows.createWorkflow(
      "Frozen context",
      definition,
    );
    await workflows.publishWorkflowVersion(created.workflowId, created.version);
    await workflows.createTrigger({
      name: "Frozen context trigger",
      workflowId: created.workflowId,
      workflowVersion: created.version,
      conditions: {
        chatIds: [monitoredChatId],
        senderIds: [],
        contentTypes: ["text"],
        text: { kind: "prefix", value: "/frozen", caseSensitive: false },
        timeWindow: null,
      },
      includeFromMe: false,
      enabled: true,
    });
    const adapter = new BlueBubblesWebhookAdapter();
    const envelopes = [
      {
        guid: "frozen-one",
        text: "Fictional message one",
        at: 1_788_000_001_000,
      },
      { guid: "frozen-two", text: "/frozen two", at: 1_788_000_002_000 },
      {
        guid: "frozen-three",
        text: "Fictional message three",
        at: 1_788_000_003_000,
      },
    ].map((message) =>
      adapter.normalize(
        newMessageWebhook({
          messageGuid: message.guid,
          text: message.text,
          dateCreated: message.at,
        }),
        crypto.randomUUID(),
      ),
    );
    for (const normalized of envelopes) {
      expect(normalized.kind).toBe("message");
      if (normalized.kind === "message") {
        await archive.ingestMessage(normalized.envelope, true);
      }
    }
    const triggerEnvelope = envelopes[1];
    if (triggerEnvelope?.kind !== "message") return;
    const engine = new WorkflowEngine(
      workflows,
      createDefaultNodeRegistry(workflows, replyGateway, {
        archive,
        aiRouting: new AiRoutingService(
          aiRepository,
          aiClient,
          new EnvironmentSecretResolver({
            FICTIONAL_AI_KEY: "fictional-server-secret",
          }),
        ),
      }),
      { timeZone: "Asia/Shanghai" },
    );
    await engine.handleMessage(triggerEnvelope.envelope);

    const serialized = JSON.stringify(aiClient.requests.at(-1)?.messages ?? []);
    expect(serialized).toContain("Fictional message one");
    expect(serialized).toContain("/frozen two");
    expect(serialized).not.toContain("Fictional message three");
  });

  it("rejects publishing a workflow whose AI route is unavailable", async () => {
    const definition = {
      schemaVersion: "1",
      name: "missing-route",
      startNodeId: "ask-ai",
      maxSteps: 4,
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
            maxOutputTokens: 128,
            maxOutputCharacters: 2_000,
            temperature: null,
            webSearchSources: "full",
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
