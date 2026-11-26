import { chatMessageQuerySchema } from "../modules/memory/chat-query-types.js";
import { defaultAgentSettings } from "../modules/ai/agent-settings-types.js";
import { describe, expect, it, vi } from "vitest";
import { MemoryService } from "../modules/memory/memory-service.js";
import type { MemoryRepository } from "../modules/memory/memory-repository.js";
import { defaultMemoryConfig } from "../modules/memory/memory-types.js";
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
function fixture(messages = [message], timeZone?: string) {
  const repository = {
    pool: {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      }),
    },
    allowed: vi.fn().mockResolvedValue(true),
    archiveQueries: {
      query: vi.fn().mockResolvedValue({
        queriedAt: "2026-09-11T00:00:00Z",
        rows: messages.map((message) => ({
          message,
          senderId: message.senderId,
          position: { sentAt: message.sentAt, index: String(message.index) },
        })),
      }),
    },
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
        ...(timeZone === undefined ? {} : { timeZone }),
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
describe("archived message queries", () => {
  it("validates limits, timezone and scope without accepting a chat override", () => {
    expect(chatMessageQuerySchema.parse({}).limit).toBe(20);
    for (const value of [
      { limit: 51 },
      { limit: 0 },
      { chatId: "other" },
      { from: "2026-09-10T00:00:00" },
      { from: "2026-09-11T00:00:00Z", to: "2026-09-10T00:00:00Z" },
    ])
      expect(chatMessageQuerySchema.safeParse(value).success).toBe(false);
  });
  it("reuses exact sources on repeat queries without invoking embeddings", async () => {
    const f = fixture();
    const session = await f.session();
    const first = parseResult(
      await session.execute("query_chat_messages", "{}"),
    );
    const second = parseResult(
      await session.execute("query_chat_messages", "{}"),
    );
    expect(first.status).toBe("succeeded");
    expect(second.evidence).toEqual(first.evidence);
    // Identity and time live once in the XML projection, not as repeated JSON.
    expect(Object.keys(first.evidence[0]!).sort()).toEqual(["ref", "text"]);
    expect((first.evidence[0] as { text: string }).text).toContain(
      `sender_id="${message.senderId}"`,
    );
    expect(f.embedding.identity).not.toHaveBeenCalled();
    expect(f.embedding.encode).not.toHaveBeenCalled();
  });
  it("projects chat-local timestamps and one participants map per result", async () => {
    const f = fixture([message], "Asia/Shanghai");
    f.repository.identities.mockResolvedValue([
      { sender_id: message.senderId, nickname: "虚构成员", real_name: null },
    ]);
    const result = parseResult(
      await (await f.session()).execute("query_chat_messages", "{}"),
    ) as unknown as {
      queriedAt: string;
      participants: Record<string, string>;
      evidence: { text: string }[];
    };
    expect(result.queriedAt).toBe("2026-09-11T08:00:00+08:00");
    expect(result.participants).toEqual({ [message.senderId]: "虚构成员" });
    expect(result.evidence[0]!.text).toContain(
      'sent_at="2026-09-11T00:00:00+08:00"',
    );
    expect(result.evidence[0]!.text).toContain(
      '<author kind="participant"></author>',
    );
    expect(result.evidence[0]!.text).not.toContain('Z"');
  });
  it("keeps short-message pages compact", async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({
      ...message,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      index: i + 1,
      text: "好的，明天见",
    }));
    const f = fixture(page, "Asia/Shanghai");
    f.repository.identities.mockResolvedValue([
      { sender_id: message.senderId, nickname: "虚构成员", real_name: null },
    ]);
    const content = await (
      await f.session()
    ).execute("query_chat_messages", JSON.stringify({ limit: 50 }));
    expect(parseResult(content).evidence).toHaveLength(50);
    // Previously ~636 characters per six-character message.
    expect(content.length).toBeLessThan(50 * 300);
  });
  it("distinguishes empty results, revoked access, failures and oversized evidence", async () => {
    const empty = fixture([]);
    expect(
      parseResult(
        await (await empty.session()).execute("query_chat_messages", "{}"),
      ).status,
    ).toBe("no-results");
    const revoked = fixture();
    revoked.repository.allowed.mockResolvedValue(false);
    expect(
      parseResult(
        await (await revoked.session()).execute("query_chat_messages", "{}"),
      ).status,
    ).toBe("unavailable");
    expect(revoked.repository.archiveQueries.query).not.toHaveBeenCalled();
    const failed = fixture();
    failed.repository.archiveQueries.query.mockRejectedValue(
      new Error("offline"),
    );
    expect(
      parseResult(
        await (await failed.session()).execute("query_chat_messages", "{}"),
      ).status,
    ).toBe("unavailable");
    const large = fixture([
      {
        ...message,
        text: "x".repeat(defaultAgentSettings.maxToolOutputCharacters + 100),
      },
    ]);
    expect(
      parseResult(
        await (await large.session()).execute("query_chat_messages", "{}"),
      ),
    ).toMatchObject({ status: "unavailable", truncated: true });
  });
  it("rechecks source content after the query", async () => {
    const f = fixture();
    f.repository.messages.mockResolvedValue([]);
    expect(
      parseResult(
        await (await f.session()).execute("query_chat_messages", "{}"),
      ).status,
    ).toBe("unavailable");
  });
});
