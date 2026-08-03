import { describe, expect, it } from "vitest";

import { loadConfig } from "../app/config.js";

describe("loadConfig", () => {
  it("parses monitored chat identifiers and defaults", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://example.test/bubblepilot",
      API_ACCESS_TOKEN: "a".repeat(32),
      BLUEBUBBLES_WEBHOOK_SECRET: "b".repeat(32),
      MONITORED_CHAT_IDS: "chat-one, chat-two,chat-one",
    });

    expect(config.port).toBe(8080);
    expect(config.monitoredChatIds).toEqual(new Set(["chat-one", "chat-two"]));
  });

  it("rejects short secrets", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgresql://example.test/bubblepilot",
        API_ACCESS_TOKEN: "short",
        BLUEBUBBLES_WEBHOOK_SECRET: "also-short",
      }),
    ).toThrow();
  });

  it("rejects unchanged example secrets", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgresql://example.test/bubblepilot",
        API_ACCESS_TOKEN: "CHANGE_ME_WITH_AT_LEAST_32_RANDOM_CHARACTERS",
        BLUEBUBBLES_WEBHOOK_SECRET: "b".repeat(32),
      }),
    ).toThrow();
  });
});
