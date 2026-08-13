import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../app/application.js";
import type { AppConfig } from "../app/config.js";
import {
  MessageRetentionService,
  MessageRetentionWorker,
} from "../modules/archive/message-retention-service.js";
import type {
  DeliveryResult,
  ReplyGateway,
  SendReplyCommand,
} from "../modules/integrations/bluebubbles/reply-gateway.js";
import { WorkflowCapacityError } from "../modules/workflow/execution-gate.js";
import {
  createDefaultNodeRegistry,
  NodeRegistry,
} from "../modules/workflow/node-registry.js";
import { WorkflowEngine } from "../modules/workflow/workflow-engine.js";
import {
  parseWorkflowDefinition,
  type WorkflowDefinition,
} from "../modules/workflow/workflow-definition.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";
import { InMemoryArchiveRepository } from "./support/in-memory-archive-repository.js";
import { InMemoryWorkflowRepository } from "./support/in-memory-workflow-repository.js";

const webhookSecret = "fictional-webhook-secret-32-chars-long";
const apiAccessToken = "fictional-api-access-token-32-chars-long";
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

const workflowDefinition = {
  schemaVersion: "1",
  name: "ping-reply",
  startNodeId: "check-command",
  maxSteps: 8,
  nodes: [
    {
      id: "check-command",
      type: "condition",
      version: 1,
      config: {
        field: "message.text",
        operator: "starts-with",
        value: "/ping",
        caseSensitive: false,
      },
      onTrue: "reply",
      onFalse: "skip",
    },
    {
      id: "reply",
      type: "reply",
      version: 1,
      config: {
        text: "Pong: {{message.text}}",
        replyToSourceMessage: true,
        retry: { maxAttempts: 2, initialDelayMs: 0 },
      },
      onSuccess: "done",
    },
    {
      id: "skip",
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

class FakeReplyGateway implements ReplyGateway {
  readonly commands: SendReplyCommand[] = [];
  readonly results: DeliveryResult[] = [];

  sendReply(command: SendReplyCommand): Promise<DeliveryResult> {
    this.commands.push(command);
    return Promise.resolve(
      this.results.shift() ?? {
        status: "confirmed",
        providerMessageId: "fictional-outbound-message",
      },
    );
  }
}

describe("workflow application", () => {
  let archive: InMemoryArchiveRepository;
  let workflows: InMemoryWorkflowRepository;
  let gateway: FakeReplyGateway;
  let engine: WorkflowEngine;
  let application: FastifyInstance;

  beforeEach(() => {
    archive = new InMemoryArchiveRepository();
    workflows = new InMemoryWorkflowRepository();
    gateway = new FakeReplyGateway();
    engine = new WorkflowEngine(
      workflows,
      createDefaultNodeRegistry(workflows, gateway),
    );
    application = buildApplication(config, archive, {
      logger: false,
      workflow: { repository: workflows, engine },
      messageRetention: new MessageRetentionWorker(
        new MessageRetentionService(archive, config.messageRetentionDays),
      ),
    });
  });

  afterEach(async () => {
    await application.close();
  });

  async function configureWorkflow(
    definition: WorkflowDefinition = workflowDefinition,
  ) {
    const created = await application.inject({
      method: "POST",
      url: "/api/v1/workflows",
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: { name: "Ping reply", definition },
    });
    expect(created.statusCode).toBe(201);
    const version = created.json<{
      data: { workflowId: string; version: number };
    }>().data;

    const published = await application.inject({
      method: "POST",
      url: `/api/v1/workflows/${version.workflowId}/versions/${version.version}/publish`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(published.statusCode).toBe(200);

    const trigger = await application.inject({
      method: "POST",
      url: "/api/v1/triggers",
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: {
        name: "Ping command",
        workflowId: version.workflowId,
        workflowVersion: version.version,
        enabled: true,
        conditions: {
          chatIds: [monitoredChatId],
          senderIds: [],
          contentTypes: ["text"],
          text: { kind: "prefix", value: "/ping", caseSensitive: false },
        },
      },
    });
    expect(trigger.statusCode).toBe(201);
    return {
      workflowId: version.workflowId,
      version: version.version,
      triggerId: trigger.json<{ data: { id: string } }>().data.id,
    };
  }

  it("only exposes implemented data actions in the action catalog", async () => {
    const response = await application.inject({
      method: "GET",
      url: "/api/v1/workflows/action-blocks",
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });

    expect(response.statusCode).toBe(200);
    const blocks = response.json<{
      data: Array<{
        type: string;
        outputs: Array<{ name: string; type: string }>;
        config: Array<{ name: string; type: string }>;
      }>;
    }>().data;
    const types = blocks.map((block) => block.type);
    expect(types).toContain("render-text");
    expect(
      blocks.find((block) => block.type === "load-context")?.outputs,
    ).toContainEqual(
      expect.objectContaining({ name: "participants", type: "json" }),
    );
    expect(
      blocks.find((block) => block.type === "ai-chat")?.config,
    ).toContainEqual(
      expect.objectContaining({
        name: "includeLoadedContext",
        type: "boolean",
      }),
    );
    expect(types).not.toContain("set-variable");
    expect(types).not.toContain("text-template");
    expect(types).not.toContain("json-parse");
    expect(types).not.toContain("json-get");
  });

  it("exports, previews, and imports a portable workflow as an unpublished candidate", async () => {
    const source = await application.inject({
      method: "POST",
      url: "/api/v1/workflows",
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: {
        name: "Portable fictional flow",
        definition: workflowDefinition,
      },
    });
    const sourceVersion = source.json<{
      data: { workflowId: string; version: number };
    }>().data;
    const exported = await application.inject({
      method: "GET",
      url: `/api/v1/workflows/${sourceVersion.workflowId}/versions/${sourceVersion.version}/export`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(exported.statusCode).toBe(200);
    const manifest = exported.json<{ data: Record<string, unknown> }>().data;
    expect(manifest).toMatchObject({
      kind: "BubblePilotWorkflow",
      apiVersion: "bubblepilot.io/v1",
      metadata: { name: "Portable fictional flow" },
    });

    const preview = await application.inject({
      method: "POST",
      url: "/api/v1/workflows/import/preview",
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: { manifest },
    });
    expect(preview.statusCode).toBe(200);
    const previewData = preview.json<{
      data: { valid: boolean; previewToken: string };
    }>().data;
    expect(previewData.valid).toBe(true);

    const imported = await application.inject({
      method: "POST",
      url: "/api/v1/workflows/import",
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: {
        manifest,
        previewToken: previewData.previewToken,
        mode: "create",
      },
    });
    expect(imported.statusCode).toBe(201);
    const importedData = imported.json<{
      data: { workflowId: string; workflowVersion: number; status: string };
    }>().data;
    expect(importedData.status).toBe("validated");
    expect(importedData.workflowId).not.toBe(sourceVersion.workflowId);
    const stored = workflows.workflows.get(importedData.workflowId);
    expect(stored).toMatchObject({ status: "draft", publishedVersion: null });
  });

  it("rejects a workflow import when its preview token is tampered", async () => {
    const manifest = {
      kind: "BubblePilotWorkflow",
      apiVersion: "bubblepilot.io/v1",
      metadata: { name: "Tamper test", description: "" },
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
    const preview = await application.inject({
      method: "POST",
      url: "/api/v1/workflows/import/preview",
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: { manifest },
    });
    const token = preview.json<{ data: { previewToken: string } }>().data
      .previewToken;
    const imported = await application.inject({
      method: "POST",
      url: "/api/v1/workflows/import",
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: { manifest, previewToken: `${token}x` },
    });
    expect(imported.statusCode).toBe(409);
    expect(imported.json()).toMatchObject({
      error: { code: "WORKFLOW_IMPORT_PREVIEW_INVALID" },
    });
  });

  it("renders Context and upstream outputs into text", async () => {
    const renderDefinition = parseWorkflowDefinition({
      schemaVersion: "1",
      name: "render-context",
      startNodeId: "render-input",
      maxSteps: 8,
      nodes: [
        {
          id: "render-input",
          type: "render-text",
          version: 1,
          config: {
            template:
              "{{context.event.message.senderId}}|{{context.event.message.text}}",
          },
          onSuccess: "render-reply",
        },
        {
          id: "render-reply",
          type: "render-text",
          version: 1,
          config: {
            template: "Rendered: {{context.outputs.render-input.text}}",
          },
          onSuccess: "reply",
        },
        {
          id: "reply",
          type: "reply",
          version: 1,
          config: {
            text: "unused fallback",
            replyToSourceMessage: false,
            retry: { maxAttempts: 1, initialDelayMs: 0 },
          },
          inputs: {
            text: {
              kind: "output",
              blockId: "render-reply",
              port: "text",
            },
          },
          onSuccess: "done",
        },
        {
          id: "done",
          type: "end",
          version: 1,
          config: { result: "succeeded" },
        },
      ],
    });
    await configureWorkflow(renderDefinition);

    const response = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({ text: "/ping template" }),
    });

    expect(response.statusCode).toBe(202);
    expect(gateway.commands).toMatchObject([
      {
        text: "Rendered: fictional-user@example.test|/ping template",
      },
    ]);
  });

  it("configures, matches and executes an idempotent reply workflow", async () => {
    await configureWorkflow();

    const preview = await application.inject({
      method: "POST",
      url: "/api/v1/triggers/preview",
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: {
        conditions: {
          chatIds: [monitoredChatId],
          contentTypes: ["text"],
          text: { kind: "prefix", value: "/ping" },
        },
        sample: {
          providerChatId: monitoredChatId,
          senderId: "fictional-user@example.test",
          contentType: "text",
          text: "ordinary conversation",
          isFromMe: false,
        },
      },
    });
    expect(preview.json()).toMatchObject({ data: { matched: false } });

    const timeWindowPreview = await application.inject({
      method: "POST",
      url: "/api/v1/triggers/preview",
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: {
        conditions: {
          timeWindow: {
            timeZone: "Asia/Shanghai",
            daysOfWeek: ["monday"],
            start: "09:00",
            end: "18:00",
          },
        },
        sample: {
          providerChatId: monitoredChatId,
          senderId: "fictional-user@example.test",
          sentAt: "2026-08-03T02:30:00.000Z",
          contentType: "text",
          text: "fictional scheduled message",
          isFromMe: false,
        },
      },
    });
    const timeWindowPreviewData = timeWindowPreview.json<{
      data: {
        matched: boolean;
        checks: Array<{ field: string; matched: boolean }>;
      };
    }>().data;
    expect(timeWindowPreviewData.matched).toBe(true);
    expect(
      timeWindowPreviewData.checks.find(
        (check) => check.field === "timeWindow",
      ),
    ).toEqual({ field: "timeWindow", matched: true });

    const webhook = newMessageWebhook({ text: "/ping hello" });
    const first = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: webhook,
    });
    const duplicate = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: webhook,
    });

    expect(first.statusCode).toBe(202);
    const firstData = first.json<{
      data: {
        executionIds: string[];
        matchedTriggerIds: string[];
        automationOutcome: string;
      };
    }>().data;
    expect(firstData.executionIds).toHaveLength(1);
    expect(firstData.matchedTriggerIds).toHaveLength(1);
    expect(firstData.automationOutcome).toBe("matched");
    expect(duplicate.json()).toMatchObject({
      data: {
        status: "duplicate",
        automationOutcome: "matched",
        executionIds: [],
      },
    });
    expect(gateway.commands).toHaveLength(1);
    expect(gateway.commands[0]).toMatchObject({
      providerChatId: monitoredChatId,
      text: "Pong: /ping hello",
      replyToProviderMessageId: "fake-message-guid-001",
    });

    const detail = await application.inject({
      method: "GET",
      url: `/api/v1/executions/${firstData.executionIds[0]}`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(detail.json()).toMatchObject({
      data: {
        status: "succeeded",
        workflowVersion: 1,
        nodes: [
          { nodeId: "check-command", status: "succeeded" },
          { nodeId: "reply", status: "succeeded" },
          { nodeId: "done", status: "succeeded" },
        ],
        deliveries: [{ status: "confirmed", attemptCount: 1 }],
      },
    });

    const search = await application.inject({
      method: "GET",
      url: "/api/v1/messages/search?q=ping",
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({
      data: [
        {
          providerMessageId: "fake-message-guid-001",
          executions: [
            {
              id: firstData.executionIds[0],
              workflowName: "Ping reply",
              workflowVersion: 1,
              status: "succeeded",
            },
          ],
        },
      ],
    });
  });

  it("paginates workflow executions with a stable cursor", async () => {
    await configureWorkflow();
    for (const sequence of [1, 2, 3]) {
      const response = await application.inject({
        method: "POST",
        url: "/api/v1/webhooks/bluebubbles",
        headers: { "x-bubblepilot-webhook-secret": webhookSecret },
        payload: newMessageWebhook({
          messageGuid: `pagination-execution-${sequence}`,
          text: `/ping page ${sequence}`,
        }),
      });
      expect(response.statusCode).toBe(202);
    }

    const first = await application.inject({
      method: "GET",
      url: "/api/v1/executions?limit=2",
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    const firstPage = first.json<{
      data: Array<{
        id: string;
        providerChatId: string | null;
        chatDisplayName: string | null;
        cachedPromptTokens: number | null;
        cacheEligiblePromptTokens: number;
        cacheHitRate: number | null;
      }>;
      page: { nextCursor: string | null };
    }>();
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.data[0]).toMatchObject({
      providerChatId: "iMessage;-;fictional-chat",
      chatDisplayName: null,
      cachedPromptTokens: null,
      cacheEligiblePromptTokens: 0,
      cacheHitRate: null,
    });
    expect(firstPage.page.nextCursor).toEqual(expect.any(String));

    const second = await application.inject({
      method: "GET",
      url: `/api/v1/executions?limit=2&cursor=${encodeURIComponent(
        firstPage.page.nextCursor ?? "",
      )}`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
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

  it("records an unavailable node handler instead of leaving execution running", async () => {
    await application.close();
    archive = new InMemoryArchiveRepository();
    workflows = new InMemoryWorkflowRepository();
    gateway = new FakeReplyGateway();
    engine = new WorkflowEngine(workflows, new NodeRegistry());
    application = buildApplication(config, archive, {
      logger: false,
      workflow: { repository: workflows, engine },
    });

    await configureWorkflow();
    const webhook = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "fictional-missing-handler",
        text: "/ping missing handler",
      }),
    });

    expect(webhook.statusCode).toBe(202);
    const executionId = webhook.json<{
      data: { executionIds: string[] };
    }>().data.executionIds[0];
    expect(executionId).toBeDefined();

    const detail = await application.inject({
      method: "GET",
      url: `/api/v1/executions/${executionId}`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(detail.json()).toMatchObject({
      data: {
        status: "failed",
        errorCode: "UNKNOWN_NODE_TYPE",
        currentNodeId: null,
        nodes: [],
      },
    });
  });

  it("replays a pending automation decision after temporary queue rejection", async () => {
    await application.close();
    archive = new InMemoryArchiveRepository();
    workflows = new InMemoryWorkflowRepository();
    gateway = new FakeReplyGateway();
    engine = new WorkflowEngine(
      workflows,
      createDefaultNodeRegistry(workflows, gateway),
    );
    let dispatchAttempts = 0;
    application = buildApplication(config, archive, {
      logger: false,
      workflow: {
        repository: workflows,
        engine,
        dispatcher: {
          mode: "in-process",
          dispatch(envelope) {
            dispatchAttempts += 1;
            if (dispatchAttempts === 1) {
              return Promise.reject(
                new WorkflowCapacityError("WORKFLOW_QUEUE_FULL"),
              );
            }
            return engine.handleMessage(envelope);
          },
        },
      },
    });
    await configureWorkflow();
    const webhook = newMessageWebhook({
      messageGuid: "fictional-capacity-recovery",
      text: "/ping after capacity returns",
    });

    const rejected = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: webhook,
    });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json()).toMatchObject({
      error: { code: "WORKFLOW_QUEUE_FULL" },
    });
    await expect(
      archive.listInboundEvents({ limit: 10, cursor: null }),
    ).resolves.toMatchObject([{ automationOutcome: "evaluation-pending" }]);
    expect(gateway.commands).toHaveLength(0);

    const recovered = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: webhook,
    });
    expect(recovered.statusCode).toBe(202);
    expect(recovered.json()).toMatchObject({
      data: {
        status: "duplicate",
        automationOutcome: "matched",
        executionIds: [expect.any(String)],
      },
    });
    expect(gateway.commands).toHaveLength(1);

    const completedDuplicate = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: webhook,
    });
    expect(completedDuplicate.json()).toMatchObject({
      data: {
        status: "duplicate",
        automationOutcome: "matched",
        executionIds: [],
      },
    });
    expect(dispatchAttempts).toBe(2);
    expect(gateway.commands).toHaveLength(1);
  });

  it("stops and resumes new executions at the workflow boundary", async () => {
    const configured = await configureWorkflow();
    const disabled = await application.inject({
      method: "PATCH",
      url: `/api/v1/workflows/${configured.workflowId}/enabled`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({
      data: { status: "inactive", publishedVersion: 1 },
    });

    const ignoredWhileStopped = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "workflow-stopped-message",
        text: "/ping while stopped",
      }),
    });
    expect(ignoredWhileStopped.json()).toMatchObject({
      data: {
        automationOutcome: "no-active-triggers",
        executionIds: [],
        matchedTriggerIds: [],
      },
    });

    const enabled = await application.inject({
      method: "PATCH",
      url: `/api/v1/workflows/${configured.workflowId}/enabled`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ data: { status: "active" } });

    const resumed = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "workflow-resumed-message",
        text: "/ping after resume",
      }),
    });
    expect(resumed.json()).toMatchObject({
      data: { executionIds: [expect.any(String)] },
    });
    expect(gateway.commands).toHaveLength(1);
  });

  it("does not trigger ordinary or self-authored messages by default", async () => {
    await configureWorkflow();

    for (const payload of [
      newMessageWebhook({ messageGuid: "ordinary", text: "hello" }),
      newMessageWebhook({
        messageGuid: "self-message",
        text: "/ping loop",
        isFromMe: true,
      }),
    ]) {
      const response = await application.inject({
        method: "POST",
        url: "/api/v1/webhooks/bluebubbles",
        headers: { "x-bubblepilot-webhook-secret": webhookSecret },
        payload,
      });
      expect(response.json()).toMatchObject({
        data: {
          automationOutcome: "no-trigger-match",
          executionIds: [],
        },
      });
    }
    expect(gateway.commands).toHaveLength(0);
    expect(workflows.executions.size).toBe(0);
  });

  it("reports potential duplicate-reply conflicts between active triggers", async () => {
    const configured = await configureWorkflow();
    const second = await application.inject({
      method: "POST",
      url: "/api/v1/triggers",
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: {
        name: "Broader ping command",
        workflowId: configured.workflowId,
        workflowVersion: configured.version,
        enabled: true,
        conditions: {
          text: { kind: "prefix", value: "/ping" },
        },
      },
    });
    expect(second.statusCode).toBe(201);
    const secondId = second.json<{ data: { id: string } }>().data.id;

    const response = await application.inject({
      method: "GET",
      url: "/api/v1/triggers",
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    const triggers = response.json<{
      data: Array<{ id: string; conflictingTriggerIds: string[] }>;
    }>().data;
    expect(
      triggers.find((trigger) => trigger.id === configured.triggerId)
        ?.conflictingTriggerIds,
    ).toEqual([secondId]);
    expect(
      triggers.find((trigger) => trigger.id === secondId)
        ?.conflictingTriggerIds,
    ).toEqual([configured.triggerId]);
  });

  it("publishes a new immutable version and atomically moves active triggers", async () => {
    const configured = await configureWorkflow();
    const nextDefinition = structuredClone(workflowDefinition);
    const renamedWorkflow = "Renamed ping reply";
    const replyNode = nextDefinition.nodes.find((node) => node.id === "reply");
    if (replyNode?.type !== "reply") {
      throw new Error("The reply node fixture is missing.");
    }
    replyNode.config.text = "Version two: {{message.text}}";

    const created = await application.inject({
      method: "POST",
      url: `/api/v1/workflows/${configured.workflowId}/versions`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: { name: renamedWorkflow, definition: nextDefinition },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      data: {
        workflowName: renamedWorkflow,
        definition: { name: renamedWorkflow },
      },
    });
    const nextVersion = created.json<{ data: { version: number } }>().data
      .version;
    expect(nextVersion).toBe(2);

    const workflowList = await application.inject({
      method: "GET",
      url: "/api/v1/workflows",
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(workflowList.json()).toMatchObject({
      data: [{ id: configured.workflowId, name: renamedWorkflow }],
    });

    const versions = await application.inject({
      method: "GET",
      url: `/api/v1/workflows/${configured.workflowId}/versions`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(versions.statusCode).toBe(200);
    expect(
      versions
        .json<{ data: Array<{ version: number }> }>()
        .data.map((version) => version.version),
    ).toEqual([2, 1]);

    const published = await application.inject({
      method: "POST",
      url: `/api/v1/workflows/${configured.workflowId}/versions/${nextVersion}/publish`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(published.statusCode).toBe(200);

    const triggers = await application.inject({
      method: "GET",
      url: "/api/v1/triggers",
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(triggers.json()).toMatchObject({
      data: [{ id: configured.triggerId, workflowVersion: 2, enabled: true }],
    });

    const response = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "fictional-version-two-message",
        text: "/ping version",
      }),
    });
    const executionId = response.json<{ data: { executionIds: string[] } }>()
      .data.executionIds[0];
    expect(gateway.commands[0]?.text).toBe("Version two: /ping version");
    await expect(
      workflows.getExecution(executionId ?? ""),
    ).resolves.toMatchObject({ workflowVersion: 2, status: "succeeded" });
  });

  it("rejects cyclic workflows and unsafe self-trigger configuration", async () => {
    const cyclic = await application.inject({
      method: "POST",
      url: "/api/v1/workflows",
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: {
        name: "Cyclic",
        definition: {
          schemaVersion: "1",
          name: "cyclic",
          startNodeId: "loop",
          nodes: [
            {
              id: "loop",
              type: "log",
              version: 1,
              config: { message: "loop" },
              onSuccess: "loop",
            },
          ],
        },
      },
    });
    expect(cyclic.statusCode).toBe(400);
    expect(cyclic.json()).toMatchObject({
      error: { code: "INVALID_WORKFLOW_DEFINITION" },
    });

    const configured = await configureWorkflow();
    const unsafe = await application.inject({
      method: "POST",
      url: "/api/v1/triggers",
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: {
        name: "Unsafe loop",
        workflowId: configured.workflowId,
        workflowVersion: configured.version,
        includeFromMe: true,
        enabled: true,
        conditions: { text: { kind: "prefix", value: "/ping" } },
      },
    });
    expect(unsafe.statusCode).toBe(400);
  });

  it("retries explicit transient failures and records each attempt", async () => {
    gateway.results.push(
      {
        status: "failed",
        code: "BLUEBUBBLES_HTTP_503",
        summary: "Fictional temporary failure.",
        retryable: true,
      },
      { status: "confirmed", providerMessageId: "fictional-retry-success" },
    );
    await configureWorkflow();

    const response = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({ text: "/ping retry" }),
    });
    const executionId = response.json<{ data: { executionIds: string[] } }>()
      .data.executionIds[0];
    const detail = await workflows.getExecution(executionId ?? "");

    expect(gateway.commands).toHaveLength(2);
    expect(detail).toMatchObject({
      status: "succeeded",
      deliveries: [{ status: "confirmed", attemptCount: 2 }],
    });
    expect(
      detail?.nodes.filter((node) => node.nodeId === "reply"),
    ).toMatchObject([
      { attempt: 1, status: "failed", retryable: true },
      { attempt: 2, status: "succeeded" },
    ]);
  });

  it("dead-letters an unknown reply result without sending again", async () => {
    gateway.results.push({
      status: "unknown",
      code: "BLUEBUBBLES_REPLY_TIMEOUT",
      summary: "Fictional timeout with unknown result.",
    });
    await configureWorkflow();

    const response = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({ text: "/ping uncertain" }),
    });
    const executionId = response.json<{ data: { executionIds: string[] } }>()
      .data.executionIds[0];
    const detail = await workflows.getExecution(executionId ?? "");

    expect(gateway.commands).toHaveLength(1);
    expect(detail).toMatchObject({
      status: "dead-lettered",
      errorCode: "BLUEBUBBLES_REPLY_TIMEOUT",
      deliveries: [{ status: "unknown", attemptCount: 1 }],
    });

    const retry = await application.inject({
      method: "POST",
      url: `/api/v1/executions/${executionId}/retry`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({
      error: { code: "EXECUTION_OUTBOUND_RESULT_UNKNOWN" },
    });
    expect(gateway.commands).toHaveLength(1);

    const closed = await application.inject({
      method: "POST",
      url: `/api/v1/executions/${executionId}/close`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(closed.statusCode).toBe(200);
    const closedBody = closed.json<{
      data: {
        status: string;
        nodes: unknown[];
        deliveries: Array<{ status: string }>;
        aiProviderAttempts: unknown[];
      };
    }>();
    expect(closedBody).toMatchObject({
      data: {
        status: "closed",
        deliveries: [{ status: "unknown" }],
        aiProviderAttempts: [],
      },
    });
    expect(closedBody.data.nodes).toBeInstanceOf(Array);

    const recoveryQueue = await application.inject({
      method: "GET",
      url: "/api/v1/executions?status=retrying,dead-lettered,closed",
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(recoveryQueue.json()).toMatchObject({
      data: [{ id: executionId, status: "closed" }],
    });

    const operations = await application.inject({
      method: "GET",
      url: "/api/v1/operations/status",
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    const operationsBody = operations.json<{
      data: {
        status: string;
        workflow: { outbound: { unknown: number } };
        executionGate: { active: number; queued: number };
        messageRetention: { enabled: boolean; retentionDays: number };
        alerts: Array<{ code: string }>;
      };
    }>();
    expect(operationsBody).toMatchObject({
      data: {
        status: "critical",
        workflow: { outbound: { unknown: 1 } },
        executionGate: { active: 0, queued: 0 },
        messageRetention: { enabled: true, retentionDays: 90 },
      },
    });
    expect(operationsBody.data.alerts.map((alert) => alert.code)).toContain(
      "UNKNOWN_OUTBOUND_DELIVERIES",
    );
  });

  it("creates a linked execution for a safe manual retry", async () => {
    gateway.results.push(
      {
        status: "failed",
        code: "BLUEBUBBLES_HTTP_503",
        summary: "Fictional temporary failure.",
        retryable: true,
      },
      {
        status: "failed",
        code: "BLUEBUBBLES_HTTP_503",
        summary: "Fictional temporary failure.",
        retryable: true,
      },
      { status: "confirmed", providerMessageId: "fictional-recovery-success" },
    );
    await configureWorkflow();

    const response = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "fictional-manual-recovery",
        text: "/ping recover",
      }),
    });
    const executionId = response.json<{ data: { executionIds: string[] } }>()
      .data.executionIds[0];
    await expect(
      workflows.getExecution(executionId ?? ""),
    ).resolves.toMatchObject({ status: "dead-lettered" });
    await workflows.markExecutionRetrying(
      executionId ?? "",
      "reply",
      new Date(Date.now() - 600_000),
      "BLUEBUBBLES_HTTP_503",
    );

    const retry = await application.inject({
      method: "POST",
      url: `/api/v1/executions/${executionId}/retry`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(retry.statusCode).toBe(201);
    const recovery = retry.json<{
      data: {
        id: string;
        status: string;
        retryOfExecutionId: string;
        recoveryAttempt: number;
        nodes: unknown[];
        deliveries: unknown[];
        aiProviderAttempts: unknown[];
      };
    }>().data;
    expect(recovery).toMatchObject({
      status: "succeeded",
      retryOfExecutionId: executionId,
      recoveryAttempt: 1,
      aiProviderAttempts: [],
    });
    expect(recovery.nodes).toBeInstanceOf(Array);
    expect(recovery.deliveries).toBeInstanceOf(Array);
    expect(recovery.id).not.toBe(executionId);
    expect(gateway.commands).toHaveLength(3);
    await expect(
      workflows.getExecution(executionId ?? ""),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "STALE_RETRY_RECOVERED",
      nextRetryAt: null,
    });

    const duplicateRetry = await application.inject({
      method: "POST",
      url: `/api/v1/executions/${executionId}/retry`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(duplicateRetry.statusCode).toBe(409);
    expect(duplicateRetry.json()).toMatchObject({
      error: { code: "EXECUTION_RECOVERY_ALREADY_CREATED" },
    });
  });

  it("does not resume a scheduled retry after the execution is closed", async () => {
    gateway.results.push({
      status: "failed",
      code: "BLUEBUBBLES_HTTP_503",
      summary: "Fictional temporary failure.",
      retryable: true,
    });
    await configureWorkflow(
      parseWorkflowDefinition({
        ...workflowDefinition,
        nodes: workflowDefinition.nodes.map((node) =>
          node.id === "reply"
            ? {
                ...node,
                config: {
                  ...node.config,
                  retry: { maxAttempts: 2, initialDelayMs: 200 },
                },
              }
            : node,
        ),
      }),
    );

    const webhook = application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "fictional-close-during-retry",
        text: "/ping close",
      }),
    });

    let executionId = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const retrying = (
        await workflows.listExecutions({ limit: 10, cursor: null })
      ).find((execution) => execution.status === "retrying");
      if (retrying !== undefined) {
        executionId = retrying.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(executionId).not.toBe("");

    const activeRetry = await application.inject({
      method: "POST",
      url: `/api/v1/executions/${executionId}/retry`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(activeRetry.statusCode).toBe(409);
    expect(activeRetry.json()).toMatchObject({
      error: { code: "EXECUTION_RETRY_STILL_ACTIVE" },
    });

    const closed = await application.inject({
      method: "POST",
      url: `/api/v1/executions/${executionId}/close`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(closed.statusCode).toBe(200);
    await webhook;

    expect(gateway.commands).toHaveLength(1);
    await expect(workflows.getExecution(executionId)).resolves.toMatchObject({
      status: "closed",
      nextRetryAt: null,
    });
  });
});
