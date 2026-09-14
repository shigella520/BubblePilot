import { describe, expect, it, vi } from "vitest";
import { MemoryService } from "../modules/memory/memory-service.js";
import type { MemoryRepository } from "../modules/memory/memory-repository.js";
import {
  latestChatMessagesSchema,
  defaultMemoryConfig,
} from "../modules/memory/memory-types.js";
import type { MemoryMessage } from "../modules/memory/chunking.js";

function parseResult(value: string): { status: string; evidence: unknown[] } {
  return JSON.parse(value) as { status: string; evidence: unknown[] };
}

const message: MemoryMessage = {
  id: "fictional-message",
  index: 2,
  sentAt: "2026-09-10T16:00:00.000Z",
  senderId: "alice@example.test",
  role: "user",
  text: "虚构发言",
  hash: "fixture",
};
function fixture(messages = [message]) {
  const repository = {
    pool: {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      }),
    },
    allowed: vi.fn().mockResolvedValue(true),
    latest: vi.fn().mockResolvedValue(messages),
    messages: vi
      .fn()
      .mockImplementation((_chat, index) =>
        Promise.resolve(messages.filter((m) => m.index === index)),
      ),
    identities: vi.fn().mockResolvedValue([]),
  };
  const embedding = {
    identity: vi.fn().mockRejectedValue(new Error("offline")),
    encode: vi.fn().mockRejectedValue(new Error("offline")),
  };
  const service = new MemoryService(
    repository as unknown as MemoryRepository,
    embedding,
  );
  return {
    repository,
    embedding,
    session: () =>
      service.session({
        chatId: "fictional-chat",
        upperIndex: 3,
        executionId: null,
        generation: {
          id: "fictional-generation",
          config: defaultMemoryConfig,
          identity: "fixture",
          encrypted_secret: null,
          status: "active",
        },
      }),
  };
}
describe("latest chat messages", () => {
  it("validates limits, timezone and scope without accepting a chat override", () => {
    expect(latestChatMessagesSchema.parse({}).limit).toBe(1);
    for (const value of [
      { limit: 21 },
      { limit: 0 },
      { chatId: "other" },
      { from: "2026-09-10T00:00:00" },
      { from: "2026-09-11T00:00:00Z", to: "2026-09-10T00:00:00Z" },
    ])
      expect(latestChatMessagesSchema.safeParse(value).success).toBe(false);
  });
  it("reuses exact sources on repeat queries without invoking embeddings", async () => {
    const f = fixture();
    const session = await f.session();
    const first = parseResult(
      await session.execute("get_latest_chat_messages", "{}"),
    );
    const second = parseResult(
      await session.execute("get_latest_chat_messages", "{}"),
    );
    expect(first.status).toBe("succeeded");
    expect(second.evidence).toEqual(first.evidence);
    expect(first.evidence[0]).toMatchObject({
      messageId: message.id,
      sentAt: message.sentAt,
      senderId: message.senderId,
    });
    expect(f.embedding.identity).not.toHaveBeenCalled();
    expect(f.embedding.encode).not.toHaveBeenCalled();
  });
  it("distinguishes empty results, revoked access, failures and oversized evidence", async () => {
    const empty = fixture([]);
    expect(
      parseResult(
        await (await empty.session()).execute("get_latest_chat_messages", "{}"),
      ).status,
    ).toBe("no-results");
    const revoked = fixture();
    revoked.repository.allowed.mockResolvedValue(false);
    expect(
      parseResult(
        await (
          await revoked.session()
        ).execute("get_latest_chat_messages", "{}"),
      ).status,
    ).toBe("unavailable");
    expect(revoked.repository.latest).not.toHaveBeenCalled();
    const failed = fixture();
    failed.repository.latest.mockRejectedValue(new Error("offline"));
    expect(
      parseResult(
        await (
          await failed.session()
        ).execute("get_latest_chat_messages", "{}"),
      ).status,
    ).toBe("unavailable");
    const large = fixture([{ ...message, text: "x".repeat(24100) }]);
    expect(
      parseResult(
        await (await large.session()).execute("get_latest_chat_messages", "{}"),
      ),
    ).toMatchObject({ status: "unavailable", truncated: true });
  });
  it("rechecks source content after the query", async () => {
    const f = fixture();
    f.repository.messages.mockResolvedValue([]);
    expect(
      parseResult(
        await (await f.session()).execute("get_latest_chat_messages", "{}"),
      ).status,
    ).toBe("unavailable");
  });
});
