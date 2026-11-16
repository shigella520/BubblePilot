import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import type {
  ReplyGateway,
  SendReplyCommand,
} from "../modules/integrations/bluebubbles/reply-gateway.js";
import { createDefaultNodeRegistry } from "../modules/workflow/node-registry.js";
import {
  parseTriggerConditions,
  matchTrigger,
} from "../modules/workflow/trigger-matcher.js";
import { parseWorkflowDefinition } from "../modules/workflow/workflow-definition.js";
import { WorkflowEngine } from "../modules/workflow/workflow-engine.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";
import { InMemoryWorkflowRepository } from "./support/in-memory-workflow-repository.js";

const chat = "iMessage;+;fictional-group";
const adapter = new BlueBubblesWebhookAdapter();
function message(
  text: string,
  options: { target?: string; chat?: string; self?: boolean } = {},
) {
  const input = newMessageWebhook({
    chatGuid: options.chat ?? chat,
    messageGuid: randomUUID(),
    text,
    isFromMe: options.self ?? false,
  });
  const event = adapter.normalize(
    {
      ...input,
      data: {
        ...input.data,
        ...(options.target ? { threadOriginatorGuid: options.target } : {}),
      },
    },
    randomUUID(),
  );
  if (event.kind !== "message") throw new Error("fictional fixture failed");
  return event.envelope;
}

describe("reply wakeup", () => {
  let repo: InMemoryWorkflowRepository;
  let engine: WorkflowEngine;
  let sent: SendReplyCommand[];
  beforeEach(() => {
    repo = new InMemoryWorkflowRepository();
    sent = [];
    const gateway: ReplyGateway = {
      sendReply(command) {
        sent.push(command);
        return Promise.resolve({
          status: "confirmed",
          providerMessageId: `fictional-bot-${sent.length}`,
        });
      },
    };
    engine = new WorkflowEngine(repo, createDefaultNodeRegistry(repo, gateway));
  });
  afterEach(async () => {
    await engine.close();
  });
  async function workflow(name: string, keyword: string) {
    const definition = parseWorkflowDefinition({
      schemaVersion: "1",
      name,
      startNodeId: "message-trigger",
      nodes: [
        {
          id: "message-trigger",
          type: "message-trigger",
          version: 1,
          config: { enabled: true },
          onSuccess: "reply",
        },
        {
          id: "reply",
          type: "reply",
          version: 1,
          config: { text: "收到：{{message.text}}" },
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
    const version = await repo.createWorkflow(name, definition);
    await repo.publishWorkflowVersion(version.workflowId, version.version);
    const trigger = await repo.createTrigger({
      name,
      workflowId: version.workflowId,
      workflowVersion: version.version,
      conditions: parseTriggerConditions({
        chatIds: [chat],
        contentTypes: ["text"],
        text: { kind: "keyword", value: keyword },
      }),
      includeFromMe: false,
      enabled: true,
    });
    if (!trigger) throw new Error("trigger fixture failed");
    return { version, trigger };
  }

  it("routes an unaddressed reply to its originating workflow once, without silencing ordinary matches", async () => {
    const blue = await workflow("fictional-blue", "blue");
    const red = await workflow("fictional-red", "red");
    await engine.handleMessage(message("blue hello"));
    const followup = message("please explain", { target: "fictional-bot-1" });
    const result = await engine.handleMessage(followup);
    expect(result.matchedTriggerIds).toEqual([blue.trigger.id]);
    expect(result.replyWake).toEqual({ status: "resolved", decision: "reply" });
    expect(
      (await repo.getExecution(result.executionIds[0]!))?.messageMatchSource,
    ).toBe("reply");
    expect(sent).toHaveLength(2);
    await engine.handleMessage(followup);
    expect(sent).toHaveLength(2);

    const both = await engine.handleMessage(
      message("red hello", { target: "fictional-bot-1" }),
    );
    expect(new Set(both.matchedTriggerIds)).toEqual(
      new Set([blue.trigger.id, red.trigger.id]),
    );
    expect(sent).toHaveLength(4);
  });

  it("bypasses only text, blocks self replies, and uses ordinary matching when both paths match", () => {
    const conditions = parseTriggerConditions({
      chatIds: [chat],
      senderIds: ["fictional-user@example.test"],
      contentTypes: ["text"],
      text: { kind: "prefix", value: "/wake" },
    });
    expect(
      matchTrigger(message("followup"), conditions, false, true),
    ).toMatchObject({ matched: true, matchSource: "reply" });
    expect(
      matchTrigger(message("/wake followup"), conditions, false, true),
    ).toMatchObject({ matched: true, matchSource: "ordinary" });
    expect(
      matchTrigger(
        message("followup", { chat: "iMessage;+;other" }),
        conditions,
        false,
        true,
      ).matched,
    ).toBe(false);
    const allowSelf = parseTriggerConditions({
      text: { kind: "prefix", value: "/wake" },
    });
    expect(
      matchTrigger(message("followup", { self: true }), allowSelf, true, true)
        .matched,
    ).toBe(false);
    expect(
      matchTrigger(message("/wake", { self: true }), allowSelf, true, true)
        .matchSource,
    ).toBe("ordinary");
  });

  it.each([
    { kind: "keyword", value: "fictional-wake" },
    { kind: "prefix", value: "/fictional" },
    { kind: "regex", value: "^fictional.*$" },
  ] as const)(
    "bypasses a $kind text condition but keeps other restrictions",
    (text) => {
      const allowed = parseTriggerConditions({
        chatIds: [chat],
        senderIds: ["fictional-user@example.test"],
        contentTypes: ["text"],
        text,
      });
      const followup = message("please explain");
      expect(matchTrigger(followup, allowed, false, true).matchSource).toBe(
        "reply",
      );
      expect(
        matchTrigger(
          followup,
          { ...allowed, senderIds: ["someone-else@example.test"] },
          false,
          true,
        ).matched,
      ).toBe(false);
      expect(
        matchTrigger(
          followup,
          { ...allowed, contentTypes: ["attachment"] },
          false,
          true,
        ).matched,
      ).toBe(false);
      expect(
        matchTrigger(
          followup,
          {
            ...allowed,
            timeWindow: {
              timeZone: "UTC",
              daysOfWeek: ["monday"],
              start: "00:00",
              end: "00:01",
            },
          },
          false,
          true,
        ).matched,
      ).toBe(false);
    },
  );

  it("never uses the reply entry when the message-trigger node is disabled", async () => {
    const blue = await workflow("fictional-blue", "blue");
    await engine.handleMessage(message("blue hello"));
    const nextDefinition = parseWorkflowDefinition({
      ...blue.version.definition,
      nodes: blue.version.definition.nodes.map((node) =>
        node.type === "message-trigger"
          ? { ...node, config: { ...node.config, enabled: false } }
          : node,
      ),
    });
    const next = await repo.createWorkflowVersion(
      blue.version.workflowId,
      nextDefinition,
    );
    if (!next) throw Error("version fixture failed");
    await repo.publishWorkflowVersion(next.workflowId, next.version);
    const result = await engine.handleMessage(
      message("followup", { target: "fictional-bot-1" }),
    );
    expect(result.executionIds).toHaveLength(0);
    expect(result.replyWake).toEqual({
      status: "resolved",
      decision: "blocked",
    });
  });

  it("does not route unknown, cross-chat, ambiguous or failed provenance", async () => {
    await workflow("fictional-blue", "blue");
    await engine.handleMessage(message("blue hello"));
    expect(
      (await engine.handleMessage(message("followup", { target: "not-a-bot" })))
        .replyWake?.status,
    ).toBe("unmatched");
    expect(
      (
        await engine.handleMessage(
          message("followup", {
            target: "fictional-bot-1",
            chat: "iMessage;+;other",
          }),
        )
      ).replyWake?.status,
    ).toBe("unmatched");
    const first = [...repo.deliveries.values()][0]!;
    repo.deliveries.set("duplicate", {
      ...first,
      id: randomUUID(),
      idempotencyKey: "duplicate",
    });
    expect(
      (
        await engine.handleMessage(
          message("followup", { target: "fictional-bot-1" }),
        )
      ).replyWake?.status,
    ).toBe("ambiguous");
    vi.spyOn(repo, "resolveReplyWake").mockRejectedValueOnce(
      new Error("fictional lookup failure"),
    );
    const ordinary = await engine.handleMessage(
      message("blue still works", { target: "fictional-bot-1" }),
    );
    expect(ordinary.executionIds).toHaveLength(1);
    expect(ordinary.replyWake?.status).toBe("lookup-error");
  });

  it("adds at most one reply-only execution for duplicate triggers of one workflow", async () => {
    const blue = await workflow("fictional-blue", "blue");
    await engine.handleMessage(message("blue hello"));
    await repo.createTrigger({
      name: "second",
      workflowId: blue.version.workflowId,
      workflowVersion: blue.version.version,
      conditions: parseTriggerConditions({
        chatIds: [chat],
        text: { kind: "prefix", value: "other" },
      }),
      includeFromMe: false,
      enabled: true,
    });
    const reply = await engine.handleMessage(
      message("followup", { target: "fictional-bot-1" }),
    );
    expect(reply.executionIds).toHaveLength(1);
    const ordinary = await engine.handleMessage(
      message("blue hello", { target: "fictional-bot-1" }),
    );
    expect(ordinary.executionIds).toHaveLength(1);
    expect(ordinary.replyWake?.decision).toBe("ordinary");
  });

  it("does not reinterpret a frozen reply using a later workflow version", async () => {
    const blue = await workflow("fictional-blue", "blue");
    await engine.handleMessage(message("blue hello"));
    const followup = message("followup", { target: "fictional-bot-1" });
    expect((await engine.handleMessage(followup)).executionIds).toHaveLength(1);
    const next = await repo.createWorkflowVersion(
      blue.version.workflowId,
      blue.version.definition,
    );
    if (!next) throw Error("version fixture failed");
    await repo.publishWorkflowVersion(next.workflowId, next.version);
    await repo.updateTrigger(blue.trigger.id, {
      name: "changed",
      includeFromMe: false,
      conditions: parseTriggerConditions({
        chatIds: [chat],
        text: { kind: "keyword", value: "followup" },
      }),
    });
    expect((await engine.handleMessage(followup)).executionIds).toHaveLength(0);
    expect(sent).toHaveLength(2);
  });

  it("bounds a stalled provenance lookup and still dispatches an ordinary match", async () => {
    await workflow("fictional-blue", "blue");
    vi.spyOn(repo, "resolveReplyWake").mockImplementation(
      () => new Promise(() => {}),
    );
    vi.useFakeTimers();
    try {
      const result = engine.handleMessage(
        message("blue hello", { target: "fictional-bot" }),
      );
      await vi.advanceTimersByTimeAsync(2_001);
      expect(await result).toMatchObject({
        replyWake: { status: "lookup-error", decision: "not-applicable" },
        executionIds: [expect.any(String)],
      });
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares the same time budget with the frozen-choice lookup", async () => {
    await workflow("fictional-blue", "blue");
    await engine.handleMessage(message("blue hello"));
    vi.spyOn(repo, "freezeReplyWakeChoice").mockImplementation(
      () => new Promise(() => {}),
    );
    vi.useFakeTimers();
    try {
      const result = engine.handleMessage(
        message("followup", { target: "fictional-bot-1" }),
      );
      await vi.advanceTimersByTimeAsync(2_001);
      expect(await result).toMatchObject({
        replyWake: { status: "lookup-error", decision: "not-applicable" },
        executionIds: [],
      });
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
