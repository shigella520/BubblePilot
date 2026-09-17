import {
  memoryMessage,
  type MessageRow,
} from "../modules/memory/archive-message.js";
import { describe, it, expect } from "vitest";
import { conversationHistoryMessages } from "../modules/workflow/node-registry.js";
import {
  chatMessageQuerySchema,
  chatCountQuerySchema,
} from "../modules/memory/chat-query-types.js";
import { botIdentityUpdateSchema } from "../modules/identity/bot-identity-service.js";
import type { ContextMessage } from "../modules/archive/archive-repository.js";
const alice = "11111111-1111-4111-8111-111111111111",
  bob = "22222222-2222-4222-8222-222222222222";
function message(workflowId?: string, nickname = "虚构角色"): ContextMessage {
  return {
    providerMessageId: workflowId ?? "unknown",
    senderId: null,
    sentAt: "2026-01-01T00:00:00Z",
    body: "虚构承诺",
    isFromMe: true,
    attachments: [],
    linkPreview: { status: "not-requested", items: [], errorCode: null },
    ...(workflowId
      ? {
          author: {
            kind: "bot" as const,
            workflowId,
            nickname,
            version: 1,
            basis: "send-snapshot" as const,
            revision: 1,
          },
        }
      : {}),
  };
}
describe("Bot author isolation", () => {
  it("keeps unknown-author diagnostic changes out of evidence hashes", () => {
    const row: MessageRow = {
      id: alice,
      message_index: "1",
      sent_at: "2026-01-01T00:00:00Z",
      sender_id: null,
      is_from_me: true,
      body: "fictional",
      attachments: [],
      link_previews: [],
      images: null,
      author: { kind: "unknown-self", reason: null },
    };
    const original = memoryMessage(row);
    expect(
      memoryMessage({
        ...row,
        author: { kind: "unknown-self", reason: "ambiguous" },
      }).hash,
    ).toBe(original.hash);
    expect(
      memoryMessage({
        ...row,
        author: {
          kind: "bot",
          workflowId: alice,
          nickname: null,
          version: 0,
          revision: 1,
          basis: "historical-mapping",
        },
      }).hash,
    ).not.toBe(original.hash);
  });
  it("only recognizes its own stable workflow, even with identical nicknames", () => {
    const result = conversationHistoryMessages(
      [message(alice), message(bob), message()],
      {},
      [],
      "UTC",
      undefined,
      [],
      { workflowId: alice, nickname: "虚构新昵称", version: 2 },
    );
    expect(result.map((m) => m.role)).toEqual(["assistant", "user", "user"]);
    expect(result[1]?.content).toContain(bob);
    expect(result[2]?.content).toContain("来源未知");
  });
  it("does not adopt unrecorded authors or nicknames as identity", () => {
    expect(
      conversationHistoryMessages([message(alice)], {}).map((m) => m.role),
    ).toEqual(["user"]);
  });
  it("rejects ambiguous filters and empty or instruction-control nicknames", () => {
    expect(
      chatMessageQuerySchema.safeParse({
        senderId: "fictional",
        botWorkflowId: alice,
      }).success,
    ).toBe(false);
    expect(
      chatCountQuerySchema.parse({ botWorkflowId: alice }).botWorkflowId,
    ).toBe(alice);
    expect(
      botIdentityUpdateSchema.safeParse({ nickname: " ", expectedVersion: 0 })
        .success,
    ).toBe(false);
    expect(
      botIdentityUpdateSchema.safeParse({
        nickname: "甲\n乙",
        expectedVersion: 0,
      }).success,
    ).toBe(false);
  });
});
