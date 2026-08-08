import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../app/application.js";
import type { AppConfig } from "../app/config.js";
import { InMemoryArchiveRepository } from "./support/in-memory-archive-repository.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 8080,
  databaseUrl: "postgresql://unused.example.test/bubblepilot",
  databaseQueryTimeoutMs: 30_000,
  apiAccessToken: "fictional-api-access-token-32-chars-long",
  settingsEncryptionKey: "fictional-settings-encryption-key-32-chars",
  loginPasswordHash: "scrypt$16384$8$1$fictional-salt$fictional-key",
  sensitiveOperationPasswordHash:
    "scrypt$16384$8$1$fictional-salt$fictional-key",
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

describe("static asset isolation", () => {
  let application: FastifyInstance;
  let temporaryRoot: string;
  let webRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "bubblepilot-static-"));
    webRoot = join(temporaryRoot, "public");
    await mkdir(join(webRoot, "assets"), { recursive: true });
    await writeFile(join(webRoot, "index.html"), "fictional web entry");
    await writeFile(join(webRoot, "assets", "app.js"), "fictional asset");
    await writeFile(
      join(temporaryRoot, "private.txt"),
      "must-not-leave-static-root",
    );
    await writeFile(join(webRoot, ".hidden"), "must-not-serve-dotfiles");

    application = buildApplication(config, new InMemoryArchiveRepository(), {
      logger: false,
      webRoot,
    });
  });

  afterEach(async () => {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("serves built web files without shadowing API routes", async () => {
    const index = await application.inject({ method: "GET", url: "/" });
    const asset = await application.inject({
      method: "GET",
      url: "/assets/app.js",
    });
    const health = await application.inject({
      method: "GET",
      url: "/health/live",
    });
    const protectedApi = await application.inject({
      method: "GET",
      url: "/api/v1/chats",
    });

    expect(index.statusCode).toBe(200);
    expect(index.body).toBe("fictional web entry");
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe("fictional asset");
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(protectedApi.statusCode).toBe(401);
  });

  it.each([
    "/../private.txt",
    "/%2e%2e/private.txt",
    "/%2e%2e%2fprivate.txt",
    "/..%2fprivate.txt",
    "/%252e%252e%252fprivate.txt",
    "/%2e%2e%5cprivate.txt",
    "/.hidden",
  ])(
    "does not expose files outside the public asset set through %s",
    async (url) => {
      const response = await application.inject({ method: "GET", url });

      expect(response.statusCode).not.toBe(200);
      expect(response.body).not.toContain("must-not-leave-static-root");
      expect(response.body).not.toContain("must-not-serve-dotfiles");
    },
  );
});
