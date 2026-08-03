import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../app/application.js";
import type { AppConfig } from "../app/config.js";
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
  blueBubblesWebhookSecret: webhookSecret,
  monitoredChatIds: new Set([monitoredChatId]),
  webhookBodyLimitBytes: 1_048_576,
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
      data: { status: "ignored", messageId: null },
    });

    const chatsResponse = await application.inject({
      method: "GET",
      url: "/api/v1/chats",
      headers: { authorization: `Bearer ${apiAccessToken}` },
    });
    expect(chatsResponse.json()).toMatchObject({ data: [] });
  });

  it("records unsupported event types as ignored", async () => {
    const response = await application.inject({
      method: "POST",
      url: "/api/v1/webhooks/bluebubbles",
      headers: { "x-bubblepilot-webhook-secret": webhookSecret },
      payload: { type: "hello-world", data: { message: "fictional probe" } },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ data: { status: "ignored" } });
    expect(repository.events.size).toBe(1);
  });
});
