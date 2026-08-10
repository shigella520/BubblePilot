import { describe, expect, it } from "vitest";

import { loadConfig } from "../app/config.js";

describe("loadConfig", () => {
  it("parses monitored chat identifiers and defaults", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://example.test/bubblepilot",
      API_ACCESS_TOKEN: "a".repeat(32),
      APP_LOGIN_PASSWORD_HASH:
        "scrypt$16384$8$1$fictional-salt$fictional-password-key",
      SENSITIVE_OPERATION_PASSWORD_HASH:
        "scrypt$16384$8$1$fictional-salt$fictional-sensitive-key",
      BLUEBUBBLES_WEBHOOK_SECRET: "b".repeat(32),
      BLUEBUBBLES_SERVER_URL: "https://bluebubbles.example.test/",
      BLUEBUBBLES_ACCESS_TOKEN: "fictional-bluebubbles-token",
      MONITORED_CHAT_IDS: "chat-one, chat-two,chat-one",
    });

    expect(config.port).toBe(8080);
    expect(config.databaseQueryTimeoutMs).toBe(30_000);
    expect(config.blueBubblesServerUrl).toBe(
      "https://bluebubbles.example.test",
    );
    expect(config.monitoredChatIds).toEqual(new Set(["chat-one", "chat-two"]));
    expect(config.messageRetentionDays).toBe(90);
    expect(config.workflowMaxConcurrency).toBe(4);
    expect(config.workflowQueueCapacity).toBe(64);
    expect(config.adminRateLimitMax).toBe(600);
    expect(config.sessionCookieSecure).toBe("auto");
    expect(config.searxngLanguage).toBe("zh-CN");
    expect(config.aiRequestTraceEnabled).toBe(false);
  });

  it("supports temporary AI request structure tracing", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://example.test/bubblepilot",
      API_ACCESS_TOKEN: "a".repeat(32),
      APP_LOGIN_PASSWORD_HASH:
        "scrypt$16384$8$1$fictional-salt$fictional-password-key",
      SENSITIVE_OPERATION_PASSWORD_HASH:
        "scrypt$16384$8$1$fictional-salt$fictional-sensitive-key",
      BLUEBUBBLES_WEBHOOK_SECRET: "b".repeat(32),
      BLUEBUBBLES_SERVER_URL: "https://bluebubbles.example.test",
      BLUEBUBBLES_ACCESS_TOKEN: "fictional-bluebubbles-token",
      AI_REQUEST_TRACE_ENABLED: "true",
    });
    expect(config.aiRequestTraceEnabled).toBe(true);
  });

  it("supports explicit session cookie security modes", () => {
    const environment = {
      DATABASE_URL: "postgresql://example.test/bubblepilot",
      API_ACCESS_TOKEN: "a".repeat(32),
      APP_LOGIN_PASSWORD_HASH:
        "scrypt$16384$8$1$fictional-salt$fictional-password-key",
      SENSITIVE_OPERATION_PASSWORD_HASH:
        "scrypt$16384$8$1$fictional-salt$fictional-sensitive-key",
      BLUEBUBBLES_WEBHOOK_SECRET: "b".repeat(32),
      BLUEBUBBLES_SERVER_URL: "https://bluebubbles.example.test",
      BLUEBUBBLES_ACCESS_TOKEN: "fictional-bluebubbles-token",
    };
    expect(
      loadConfig({ ...environment, SESSION_COOKIE_SECURE: "true" })
        .sessionCookieSecure,
    ).toBe("true");
    expect(
      loadConfig({ ...environment, SESSION_COOKIE_SECURE: "false" })
        .sessionCookieSecure,
    ).toBe("false");
  });

  it("accepts only bounded leaf database query timeouts", () => {
    const environment = {
      DATABASE_URL: "postgresql://example.test/bubblepilot",
      API_ACCESS_TOKEN: "a".repeat(32),
      APP_LOGIN_PASSWORD_HASH:
        "scrypt$16384$8$1$fictional-salt$fictional-password-key",
      SENSITIVE_OPERATION_PASSWORD_HASH:
        "scrypt$16384$8$1$fictional-salt$fictional-sensitive-key",
      BLUEBUBBLES_WEBHOOK_SECRET: "b".repeat(32),
      BLUEBUBBLES_SERVER_URL: "https://bluebubbles.example.test",
      BLUEBUBBLES_ACCESS_TOKEN: "fictional-bluebubbles-token",
    };
    expect(
      loadConfig({ ...environment, DATABASE_QUERY_TIMEOUT_MS: "45000" })
        .databaseQueryTimeoutMs,
    ).toBe(45_000);
    expect(() =>
      loadConfig({ ...environment, DATABASE_QUERY_TIMEOUT_MS: "999" }),
    ).toThrow();
  });

  it("allows explicit message retention opt-out and rejects invalid days", () => {
    const environment = {
      DATABASE_URL: "postgresql://example.test/bubblepilot",
      API_ACCESS_TOKEN: "a".repeat(32),
      APP_LOGIN_PASSWORD_HASH:
        "scrypt$16384$8$1$fictional-salt$fictional-password-key",
      SENSITIVE_OPERATION_PASSWORD_HASH:
        "scrypt$16384$8$1$fictional-salt$fictional-sensitive-key",
      BLUEBUBBLES_WEBHOOK_SECRET: "b".repeat(32),
      BLUEBUBBLES_SERVER_URL: "https://bluebubbles.example.test",
      BLUEBUBBLES_ACCESS_TOKEN: "fictional-bluebubbles-token",
    };
    expect(
      loadConfig({ ...environment, MESSAGE_RETENTION_DAYS: "0" })
        .messageRetentionDays,
    ).toBe(0);
    expect(() =>
      loadConfig({ ...environment, MESSAGE_RETENTION_DAYS: "-1" }),
    ).toThrow();
  });

  it("rejects short secrets", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgresql://example.test/bubblepilot",
        API_ACCESS_TOKEN: "short",
        APP_LOGIN_PASSWORD_HASH:
          "scrypt$16384$8$1$fictional-salt$fictional-password-key",
        SENSITIVE_OPERATION_PASSWORD_HASH:
          "scrypt$16384$8$1$fictional-salt$fictional-sensitive-key",
        BLUEBUBBLES_WEBHOOK_SECRET: "also-short",
        BLUEBUBBLES_SERVER_URL: "https://bluebubbles.example.test",
        BLUEBUBBLES_ACCESS_TOKEN: "fictional-bluebubbles-token",
      }),
    ).toThrow();
  });

  it("rejects unchanged example secrets", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgresql://example.test/bubblepilot",
        API_ACCESS_TOKEN: "CHANGE_ME_WITH_AT_LEAST_32_RANDOM_CHARACTERS",
        APP_LOGIN_PASSWORD_HASH:
          "scrypt$16384$8$1$fictional-salt$fictional-password-key",
        SENSITIVE_OPERATION_PASSWORD_HASH:
          "scrypt$16384$8$1$fictional-salt$fictional-sensitive-key",
        BLUEBUBBLES_WEBHOOK_SECRET: "b".repeat(32),
        BLUEBUBBLES_SERVER_URL: "https://bluebubbles.example.test",
        BLUEBUBBLES_ACCESS_TOKEN: "fictional-bluebubbles-token",
      }),
    ).toThrow();
  });

  it("rejects reuse of the login password for sensitive operations", () => {
    const reusedHash = "scrypt$16384$8$1$fictional-salt$fictional-password-key";
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgresql://example.test/bubblepilot",
        API_ACCESS_TOKEN: "a".repeat(32),
        APP_LOGIN_PASSWORD_HASH: reusedHash,
        SENSITIVE_OPERATION_PASSWORD_HASH: reusedHash,
        BLUEBUBBLES_WEBHOOK_SECRET: "b".repeat(32),
        BLUEBUBBLES_SERVER_URL: "https://bluebubbles.example.test",
        BLUEBUBBLES_ACCESS_TOKEN: "fictional-bluebubbles-token",
      }),
    ).toThrow();
  });
});
