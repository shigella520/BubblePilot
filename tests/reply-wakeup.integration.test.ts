import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import type { ReplyGateway } from "../modules/integrations/bluebubbles/reply-gateway.js";
import { createDefaultNodeRegistry } from "../modules/workflow/node-registry.js";
import { PostgresWorkflowRepository } from "../modules/workflow/postgres-workflow-repository.js";
import { parseTriggerConditions } from "../modules/workflow/trigger-matcher.js";
import { parseWorkflowDefinition } from "../modules/workflow/workflow-definition.js";
import { WorkflowEngine } from "../modules/workflow/workflow-engine.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";

const url = process.env.TEST_DATABASE_URL;
const adapter = new BlueBubblesWebhookAdapter();
describe.runIf(url !== undefined)("PostgreSQL reply wakeup", () => {
  let db: Pool;
  let repo: PostgresWorkflowRepository;
  let archive: PostgresArchiveRepository;
  beforeAll(() => {
    db = new Pool({ connectionString: url });
    repo = new PostgresWorkflowRepository(url!);
    archive = new PostgresArchiveRepository(url!);
  });
  afterAll(async () => {
    await Promise.all([db.end(), repo.close(), archive.close()]);
  });
  function incoming(chat: string, text: string, target?: string, self = false) {
    const input = newMessageWebhook({
      chatGuid: chat,
      messageGuid: randomUUID(),
      text,
      isFromMe: self,
    });
    const event = adapter.normalize(
      {
        ...input,
        data: {
          ...input.data,
          ...(target
            ? { threadOriginatorGuid: target, threadOriginatorPart: "0" }
            : {}),
        },
      },
      randomUUID(),
    );
    if (event.kind !== "message") throw Error("invalid fictional message");
    return event.envelope;
  }
  async function fixture() {
    const chat = `iMessage;+;fictional-${randomUUID()}`;
    const target = `fictional-bot-${randomUUID()}`;
    const definition = parseWorkflowDefinition({
      schemaVersion: "1",
      name: `fictional-${randomUUID()}`,
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
          config: { text: "fictional response" },
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
    const version = await repo.createWorkflow(definition.name, definition);
    await repo.publishWorkflowVersion(version.workflowId, version.version);
    const trigger = await repo.createTrigger({
      name: "fictional trigger",
      workflowId: version.workflowId,
      workflowVersion: version.version,
      conditions: parseTriggerConditions({
        chatIds: [chat],
        text: { kind: "keyword", value: "blue" },
      }),
      includeFromMe: false,
      enabled: true,
    });
    if (!trigger) throw Error("trigger fixture failed");
    const sent: string[] = [];
    const gateway: ReplyGateway = {
      sendReply() {
        sent.push(target);
        return Promise.resolve({
          status: "confirmed",
          providerMessageId: target,
        });
      },
    };
    const engine = new WorkflowEngine(
      repo,
      createDefaultNodeRegistry(repo, gateway),
    );
    const first = incoming(chat, "blue hello");
    await archive.ingestMessage(first, true);
    const firstResult = await engine.handleMessage(first);
    await archive.recordAutomationOutcome(
      first.provider,
      first.eventId,
      "matched",
      firstResult.replyWake,
    );
    return { chat, target, version, trigger, engine, sent, gateway };
  }

  it("routes and records a reply, freezes provenance, and deduplicates delivery", async () => {
    const f = await fixture();
    const reply = incoming(f.chat, "tell me more", f.target);
    await archive.ingestMessage(reply, true);
    const snapshots = await Promise.all([
      repo.resolveReplyWake(reply),
      repo.resolveReplyWake(reply),
    ]);
    expect(snapshots).toEqual([
      { status: "resolved", workflowId: f.version.workflowId },
      { status: "resolved", workflowId: f.version.workflowId },
    ]);
    await db.query(
      "UPDATE outbound_deliveries SET status='unknown' WHERE provider_message_id=$1",
      [f.target],
    );
    expect(await repo.resolveReplyWake(reply)).toEqual(snapshots[0]);
    const result = await f.engine.handleMessage(reply);
    expect(result.executionIds).toHaveLength(1);
    expect(result.replyWake).toEqual({ status: "resolved", decision: "reply" });
    const detail = await repo.getExecution(result.executionIds[0]!);
    expect(detail?.messageMatchSource).toBe("reply");
    expect(
      detail?.nodes.find((node) => node.nodeType === "message-trigger")
        ?.inputSummary,
    ).toMatchObject({ matchSource: "reply" });
    await archive.recordAutomationOutcome(
      reply.provider,
      reply.eventId,
      "matched",
      result.replyWake,
    );
    const event = (
      await archive.listInboundEvents({ limit: 100, cursor: null })
    ).find((item) => item.eventId === reply.eventId);
    expect(event?.replyWake).toEqual({ status: "resolved", decision: "reply" });
    expect((await archive.ingestMessage(reply, true)).automationOutcome).toBe(
      "matched",
    );
    expect(f.sent).toHaveLength(2);
    await f.engine.close();
  });

  it("rejects forged replay data, cross-chat matches, self messages and ambiguous deliveries", async () => {
    const f = await fixture();
    const plain = incoming(f.chat, "followup");
    await archive.ingestMessage(plain, true);
    const forged = {
      ...plain,
      message: {
        ...plain.message,
        replyReference: { targetGuid: f.target, part: "0" },
      },
    };
    expect((await repo.resolveReplyWake(forged)).status).toBe("no-reference");
    const other = incoming(
      `iMessage;+;other-${randomUUID()}`,
      "followup",
      f.target,
    );
    await archive.ingestMessage(other, true);
    expect((await repo.resolveReplyWake(other)).status).toBe("unmatched");
    const self = incoming(f.chat, "followup", f.target, true);
    await archive.ingestMessage(self, true);
    expect((await repo.resolveReplyWake(self)).status).toBe("from-me");
    await db.query(
      `INSERT INTO outbound_deliveries(id,execution_id,node_id,idempotency_key,provider,provider_chat_id,body_hash,provider_temp_guid,status,provider_message_id,confirmed_at)
      SELECT $1,execution_id,node_id,$2,provider,provider_chat_id,body_hash,$3,'confirmed',provider_message_id,now() FROM outbound_deliveries WHERE provider_message_id=$4 LIMIT 1`,
      [randomUUID(), randomUUID(), randomUUID(), f.target],
    );
    const ambiguous = incoming(f.chat, "followup", f.target);
    await archive.ingestMessage(ambiguous, true);
    expect((await repo.resolveReplyWake(ambiguous)).status).toBe("ambiguous");
    const legacy = incoming(f.chat, "followup", f.target);
    await archive.ingestMessage(legacy, true);
    await db.query(
      "UPDATE inbound_events SET reply_wake_policy=NULL WHERE external_event_id=$1",
      [legacy.eventId],
    );
    expect((await repo.resolveReplyWake(legacy)).status).toBe("legacy");
    await f.engine.close();
  });

  it("rechecks a just-pending send without waiting for the attribution worker", async () => {
    const f = await fixture();
    const reply = incoming(f.chat, "followup", f.target);
    await archive.ingestMessage(reply, true);
    await db.query(
      "UPDATE outbound_deliveries SET status='sending',provider_message_id=NULL,updated_at=now() WHERE provider_message_id=$1",
      [f.target],
    );
    const update = new Promise<void>((resolve, reject) =>
      setTimeout(() => {
        void db
          .query(
            "UPDATE outbound_deliveries SET status='confirmed',provider_message_id=$1,confirmed_at=now() WHERE provider_chat_id=$2 AND status='sending'",
            [f.target, f.chat],
          )
          .then(() => resolve(), reject);
      }, 200),
    );
    const snapshot = await repo.resolveReplyWake(reply);
    await update;
    expect(snapshot).toEqual({
      status: "resolved",
      workflowId: f.version.workflowId,
    });
    await f.engine.close();
  });

  it("does not replay a completed unmatched reply when a send confirms too late", async () => {
    const f = await fixture();
    try {
      const reply = incoming(f.chat, "followup", f.target);
      await archive.ingestMessage(reply, true);
      await db.query(
        "UPDATE outbound_deliveries SET status='sending',provider_message_id=NULL,updated_at=now() WHERE provider_message_id=$1",
        [f.target],
      );
      expect((await repo.resolveReplyWake(reply)).status).toBe("unmatched");
      await db.query(
        "UPDATE outbound_deliveries SET status='confirmed',provider_message_id=$1,confirmed_at=now() WHERE provider_chat_id=$2 AND status='sending'",
        [f.target, f.chat],
      );
      const result = await f.engine.handleMessage(reply);
      expect(result.replyWake).toEqual({
        status: "unmatched",
        decision: "not-applicable",
      });
      expect(result.executionIds).toHaveLength(0);
      await archive.recordAutomationOutcome(
        reply.provider,
        reply.eventId,
        "no-trigger-match",
        result.replyWake,
      );
      expect((await archive.ingestMessage(reply, true)).automationOutcome).toBe(
        "no-trigger-match",
      );
      expect(f.sent).toHaveLength(1);
    } finally {
      await f.engine.close();
    }
  });

  it("keeps the original match source during manual execution recovery", async () => {
    const f = await fixture();
    try {
      const reply = incoming(f.chat, "followup", f.target);
      await archive.ingestMessage(reply, true);
      const binding = (await repo.listActiveTriggerBindings()).find(
        (item) => item.id === f.trigger.id,
      );
      if (!binding) throw Error("fictional trigger unavailable");
      const created = await repo.createExecution({
        envelope: reply,
        trigger: binding,
        messageMatchSource: "reply",
      });
      await db.query(
        "UPDATE workflow_executions SET status='failed' WHERE id=$1",
        [created.execution.id],
      );
      const retry = await repo.createManualRetry(
        created.execution.id,
        randomUUID(),
        new Date(),
      );
      expect(retry.status).toBe("created");
      if (retry.status !== "created")
        throw Error("fictional retry not created");
      expect(retry.execution.messageMatchSource).toBe("reply");
      expect(retry.execution.retryOfExecutionId).toBe(created.execution.id);
    } finally {
      await f.engine.close();
    }
  });

  it("uses one frozen trigger and one delivery across concurrent engines", async () => {
    const f = await fixture();
    const secondEngine = new WorkflowEngine(
      repo,
      createDefaultNodeRegistry(repo, f.gateway),
    );
    try {
      const reply = incoming(f.chat, "tell me more", f.target);
      await archive.ingestMessage(reply, true);
      const results = await Promise.all([
        f.engine.handleMessage(reply),
        secondEngine.handleMessage(reply, { retryPending: true }),
      ]);
      expect(results[0]?.replyWake).toEqual({
        status: "resolved",
        decision: "reply",
      });
      expect(results[1]?.replyWake).toEqual({
        status: "resolved",
        decision: "reply",
      });
      expect(results[0]?.executionIds).toEqual(results[1]?.executionIds);
      expect(f.sent).toHaveLength(2);
      const stored = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM workflow_executions WHERE provider=$1 AND external_event_id=$2",
        [reply.provider, reply.eventId],
      );
      expect(stored.rows[0]?.count).toBe("1");
    } finally {
      await Promise.all([f.engine.close(), secondEngine.close()]);
    }
  });

  it("does not substitute a new workflow version after an unfinished event froze its reply choice", async () => {
    const f = await fixture();
    try {
      const reply = incoming(f.chat, "followup", f.target);
      await archive.ingestMessage(reply, true);
      expect((await repo.resolveReplyWake(reply)).status).toBe("resolved");
      expect(
        await repo.freezeReplyWakeChoice(reply, {
          decision: "reply",
          triggerId: f.trigger.id,
          workflowVersionId: f.trigger.workflowVersionId,
        }),
      ).toMatchObject({
        decision: "reply",
        workflowVersionId: f.trigger.workflowVersionId,
      });
      const next = await repo.createWorkflowVersion(
        f.version.workflowId,
        f.version.definition,
      );
      if (!next) throw Error("fictional version not created");
      await repo.publishWorkflowVersion(next.workflowId, next.version);
      const result = await f.engine.handleMessage(reply, {
        retryPending: true,
      });
      expect(result.executionIds).toHaveLength(0);
      expect(result.replyWake).toEqual({
        status: "resolved",
        decision: "blocked",
      });
      expect(f.sent).toHaveLength(1);
    } finally {
      await f.engine.close();
    }
  });
});
