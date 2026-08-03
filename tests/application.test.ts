import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../app/application.js";
import type { AppConfig } from "../app/config.js";
import { MessageRetentionService } from "../modules/archive/message-retention-service.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";
import { InMemoryArchiveRepository } from "./support/in-memory-archive-repository.js";

const webhookSecret = "fictional-webhook-secret-32-chars-long";
const apiAccessToken = "fictional-api-access-token-32-chars-long";
const monitoredChatId = "iMessage;-;fictional-chat";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 8080,
  databaseUrl: "postgresql://unused.example.test/bubblepilot",
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

describe("BubblePilot application", () => {
  let repository: InMemoryArchiveRepository;
  let application: FastifyInstance;

  beforeEach(() => {
    repository = new InMemoryArchiveRepository();
    application = buildApplication(config, repository, { logger: false });
  });

  afterEach(async () => {
    await application.close();
  });

  it("reports liveness and readiness", async () => {
    const live = await application.inject({
      method: "GET",
      url: "/health/live",
    });
    const ready = await application.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "ok" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });
  });

  it("rejects webhooks without the shared secret", async () => {
    const response = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      payload: newMessageWebhook(),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_WEBHOOK_SECRET" },
    });
    expect(repository.events.size).toBe(0);
  });

  it("rejects webhook bodies above the configured limit", async () => {
    await application.close();
    repository = new InMemoryArchiveRepository();
    application = buildApplication(
      { ...config, webhookBodyLimitBytes: 1024 },
      repository,
      { logger: false },
    );

    const response = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({ text: "x".repeat(2048) }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: { code: "WEBHOOK_PAYLOAD_TOO_LARGE" },
    });
    expect(repository.events.size).toBe(0);
  });

  it("rate-limits repeated management requests with a stable error", async () => {
    await application.close();
    repository = new InMemoryArchiveRepository();
    application = buildApplication(
      { ...config, adminRateLimitMax: 1 },
      repository,
      { logger: false },
    );
    const headers = { authorization: `Bearer ${apiAccessToken}` };

    const first = await application.inject({
      method: "GET",
      url: "/api/v1/chats",
      headers,
    });
    const limited = await application.inject({
      method: "GET",
      url: "/api/v1/chats",
      headers,
    });

    expect(first.statusCode).toBe(200);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });

  it("archives an enabled chat once and exposes it through protected queries", async () => {
    const first = await application.inject({
      method: "POST",
      url: `/api/v1/webhooks/bluebubbles?token=${encodeURIComponent(webhookSecret)}`,
      payload: newMessageWebhook(),
    });
    const duplicate = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook(),
    });

    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ data: { status: "archived" } });
    expect(duplicate.json()).toMatchObject({ data: { status: "duplicate" } });

    const unauthorized = await application.inject({
      method: "GET",
      url: "/api/v1/chats",
    });
    expect(unauthorized.statusCode).toBe(401);

    const chatsResponse = await application.inject({
      method: "GET",
      url: "/api/v1/chats",
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(chatsResponse.statusCode).toBe(200);
    const chats = chatsResponse.json<{
      data: Array<{ id: string; messageCount: number }>;
    }>();
    expect(chats.data).toHaveLength(1);
    expect(chats.data[0]?.messageCount).toBe(1);

    const messagesResponse = await application.inject({
      method: "GET",
      url: `/api/v1/chats/${chats.data[0]?.id}/messages`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(messagesResponse.statusCode).toBe(200);
    expect(messagesResponse.json()).toMatchObject({
      data: [
        {
          providerMessageId: "fake-message-guid-001",
          body: "Hello from a fictional chat",
          contentRedactedAt: null,
        },
      ],
    });
  });

  it("exposes an explicit marker after archived content is redacted", async () => {
    await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({ messageGuid: "fictional-expired-message" }),
    });
    const chat = repository.chats.get(monitoredChatId);
    const archived = chat?.messages[0];
    expect(archived).toBeDefined();
    if (archived === undefined || chat === undefined) return;
    archived.createdAt = "2026-01-01T00:00:00.000Z";

    await new MessageRetentionService(repository, 90).run(
      new Date("2026-08-03T00:00:00.000Z"),
    );
    const response = await application.inject({
      method: "GET",
      url: `/api/v1/chats/${chat.id}/messages`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [
        {
          providerMessageId: "fictional-expired-message",
          body: null,
          attachments: [],
          contentRedactedAt: "2026-08-03T00:00:00.000Z",
        },
      ],
    });
  });

  it("does not archive messages from chats outside the configured scope", async () => {
    const response = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "fake-message-outside-scope",
        chatGuid: "iMessage;-;outside-scope",
      }),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      data: {
        status: "ignored",
        messageId: null,
        automationOutcome: "chat-not-monitored",
      },
    });

    const chatsResponse = await application.inject({
      method: "GET",
      url: "/api/v1/chats",
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(chatsResponse.json()).toMatchObject({ data: [] });
  });

  it("manages discovered chat monitoring and searches only enabled archives", async () => {
    const chatGuid = "iMessage;-;managed-fictional-chat";
    const ignored = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "fake-managed-before-enabled",
        chatGuid,
        text: "This must not be archived",
      }),
    });
    expect(ignored.json()).toMatchObject({ data: { status: "ignored" } });

    const monitoring = await application.inject({
      method: "GET",
      url: "/api/v1/chat-monitoring",
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    const discovered = monitoring
      .json<{
        data: Array<{ id: string; version: number; enabled: boolean }>;
      }>()
      .data.find((chat) => !chat.enabled);
    expect(discovered).toBeDefined();

    const enabled = await application.inject({
      method: "PATCH",
      url: `/api/v1/chat-monitoring/${discovered?.id}`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: { enabled: true, expectedVersion: discovered?.version },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({
      data: { enabled: true, version: 2 },
    });

    const stale = await application.inject({
      method: "PATCH",
      url: `/api/v1/chat-monitoring/${discovered?.id}`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
      payload: { enabled: false, expectedVersion: discovered?.version },
    });
    expect(stale.statusCode).toBe(409);

    const archived = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: newMessageWebhook({
        messageGuid: "fake-managed-after-enabled",
        chatGuid,
        text: "Fictional searchable needle",
      }),
    });
    expect(archived.json()).toMatchObject({ data: { status: "archived" } });

    const search = await application.inject({
      method: "GET",
      url: `/api/v1/messages/search?chatId=${discovered?.id}&q=NEEDLE&senderId=fictional-user%40example.test&sentFrom=2026-08-01T00%3A00%3A00.000Z&sentTo=2026-09-01T00%3A00%3A00.000Z`,
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({
      data: [
        {
          chatId: discovered?.id,
          body: "Fictional searchable needle",
          contentRedactedAt: null,
          senderId: "fictional-user@example.test",
        },
      ],
    });

    const unavailable = await application.inject({
      method: "GET",
      url: "/api/v1/messages/search?chatId=00000000-0000-4000-8000-000000000001&q=needle",
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(unavailable.statusCode).toBe(200);
    expect(unavailable.json()).toMatchObject({ data: [] });
  });

  it("records unsupported event types as ignored", async () => {
    const response = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: { type: "hello-world", data: { message: "fictional probe" } },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      data: {
        status: "ignored",
        automationOutcome: "unsupported-event",
      },
    });
    expect(repository.events.size).toBe(1);
  });

  it("exposes only safe inbound decision metadata to administrators", async () => {
    await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: { type: "fictional-probe", data: { message: "private body" } },
    });

    const unauthorized = await application.inject({
      method: "GET",
      url: "/api/v1/inbound-events",
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await application.inject({
      method: "GET",
      url: "/api/v1/inbound-events?limit=10",
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(response.statusCode).toBe(200);
    const event = response.json<{ data: Array<Record<string, unknown>> }>()
      .data[0];
    expect(event).toMatchObject({
      provider: "bluebubbles",
      eventType: "fictional-probe",
      ingestionStatus: "ignored",
      automationOutcome: "unsupported-event",
    });
    expect(Object.keys(event ?? {}).sort()).toEqual(
      [
        "automationOutcome",
        "correlationId",
        "eventId",
        "eventType",
        "id",
        "ingestionStatus",
        "provider",
        "receivedAt",
      ].sort(),
    );
    expect(response.body).not.toContain("private body");
    expect(response.body).not.toContain("payloadHash");
  });
});
