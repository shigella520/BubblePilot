import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MessageRevisionService } from "../modules/archive/message-revision-service.js";
import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import { parseMessageDetail } from "../modules/integrations/bluebubbles/message-detail.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";
import type { MessageRevision } from "../modules/archive/message-revision.js";
import { IngestionService } from "../modules/ingestion/ingestion-service.js";

const url = process.env.TEST_DATABASE_URL;
describe.runIf(!!url)("archive-only message revisions", () => {
  let db: Pool;
  let archive: PostgresArchiveRepository;
  let service: MessageRevisionService;
  const details = new Map<string, MessageRevision>();
  const testGuids = new Set<string>();
  const adapter = new BlueBubblesWebhookAdapter();
  const readDetail = vi.fn((guid: string) => {
    const value = details.get(guid);
    if (!value) return Promise.reject(new Error("offline"));
    return Promise.resolve(value);
  });
  beforeAll(() => {
    db = new Pool({ connectionString: url });
    archive = new PostgresArchiveRepository(url!);
    service = new MessageRevisionService(new Pool({ connectionString: url }), {
      read: readDetail,
    });
  });
  afterEach(async () => {
    await db.query(
      "DELETE FROM message_revision_jobs WHERE provider_message_id=ANY($1::text[])",
      [[...testGuids]],
    );
    testGuids.clear();
    details.clear();
  });
  afterAll(async () => {
    await service.stop();
    await archive.close();
    await db.end();
  });
  async function fixture() {
    const guid = `revision-${randomUUID()}`;
    testGuids.add(guid);
    const chat = `fictional-chat-${randomUUID()}`;
    const normalized = adapter.normalize(
      newMessageWebhook({
        messageGuid: guid,
        chatGuid: chat,
        text: "原文",
        dateCreated: 1788000000000,
      }),
      randomUUID(),
    );
    if (normalized.kind !== "message") throw new Error("fixture");
    const saved = await archive.ingestMessage(normalized.envelope, true);
    await archive.recordAutomationOutcome(
      "bluebubbles",
      normalized.envelope.eventId,
      "not-evaluated",
    );
    const set = (time: number, extra: Record<string, unknown> = {}) => {
      details.set(
        guid,
        parseMessageDetail({
          guid,
          chats: [{ guid: chat }],
          attachments: [],
          text: "修改后",
          partCount: 1,
          dateEdited: time,
          messageSummaryInfo: [{ retractedParts: [] }],
          ...extra,
        }),
      );
    };
    const notify = async (time: number) => {
      const n = adapter.normalize(
        { type: "updated-message", data: { guid, dateEdited: time } },
        randomUUID(),
      );
      if (n.kind !== "revision") throw new Error("fixture");
      return service.enqueue(n.notification);
    };
    return {
      guid,
      chat,
      id: saved.messageId!,
      set,
      notify,
      envelope: normalized.envelope,
    };
  }
  it("edits in place without activity or execution changes; rejects duplicates and stale state", async () => {
    const f = await fixture();
    const before = (
      await db.query(
        "SELECT to_jsonb(a) data FROM idle_chat_activity a JOIN messages m ON m.chat_id=a.chat_id WHERE m.id=$1",
        [f.id],
      )
    ).rows;
    f.set(1788000001000);
    expect((await f.notify(1788000001000)).status).toBe("ignored");
    await service.tick();
    expect(await archive.findMessage(f.id)).toMatchObject({
      body: "修改后",
      revisionState: "active",
      editedAt: new Date(1788000001000).toISOString(),
    });
    expect((await f.notify(1788000001000)).status).toBe("duplicate");
    f.set(1788000000500, { text: "迟到旧编辑" });
    await f.notify(1788000000500);
    await service.tick();
    expect((await archive.findMessage(f.id))?.body).toBe("修改后");
    const after = (
      await db.query(
        "SELECT to_jsonb(a) data FROM idle_chat_activity a JOIN messages m ON m.chat_id=a.chat_id WHERE m.id=$1",
        [f.id],
      )
    ).rows;
    expect(after).toEqual(before);
    expect(
      (
        await db.query<{ n: string }>(
          "SELECT count(*) n FROM messages WHERE provider_message_id=$1",
          [f.guid],
        )
      ).rows[0]?.n,
    ).toBe("1");
    expect(
      (
        await db.query<{ n: string }>(
          "SELECT count(*) n FROM workflow_executions WHERE source_message_id=$1",
          [f.id],
        )
      ).rows[0]?.n,
    ).toBe("0");
  });
  it("withdraws text and derived content without restoring it on later edits", async () => {
    const f = await fixture();
    f.set(1788000002000, {
      partCount: 0,
      messageSummaryInfo: [{ retractedParts: [0] }],
    });
    await f.notify(1788000002000);
    await service.tick();
    expect(await archive.findMessage(f.id)).toMatchObject({
      body: null,
      attachments: [],
      revisionState: "retracted",
    });
    f.set(1788000003000);
    await f.notify(1788000003000);
    await service.tick();
    expect((await archive.findMessage(f.id))?.body).toBeNull();
  });
  it("expands only same-chat, in-window quotes and reflects target retraction", async () => {
    const f = await fixture();
    const replyInput = newMessageWebhook({
      chatGuid: f.chat,
      messageGuid: `quote-${randomUUID()}`,
      text: "好的",
    });
    const n = adapter.normalize(
      {
        ...replyInput,
        data: {
          ...replyInput.data,
          threadOriginatorGuid: f.guid,
          threadOriginatorPart: "0",
        },
      },
      randomUUID(),
    );
    if (n.kind !== "message") throw new Error("fixture");
    testGuids.add(n.envelope.message.providerMessageId);
    const saved = await archive.ingestMessage(n.envelope, true);
    expect(
      (await archive.findMessage(saved.messageId!))?.replyTo,
    ).toMatchObject({ status: "available", text_preview: "原文" });
    expect(await service.attachReply(n.envelope, "0")).toMatchObject({
      status: "available",
      text_preview: "原文",
    });
    expect(await service.attachReply(n.envelope, "1")).toEqual({
      status: "unavailable",
    });
    expect(await service.attachReply(n.envelope, null)).toEqual({
      status: "unresolved",
    });
    const bounded = await db.query<{ reply: { status: string } }>(
      "SELECT message_reply_preview($1,1,1000) reply",
      [saved.messageId],
    );
    expect(bounded.rows[0]?.reply.status).toBe("unavailable");
    f.set(1788000002000, {
      partCount: 0,
      messageSummaryInfo: [{ retractedParts: [0] }],
    });
    await f.notify(1788000002000);
    await service.tick();
    expect((await archive.findMessage(saved.messageId!))?.replyTo).toEqual({
      status: "retracted",
      message_id: f.guid,
    });
  });
  it("does not expose cross-chat targets and hides ambiguous partial content", async () => {
    const f = await fixture();
    const other = await fixture();
    await db.query(
      "UPDATE messages SET reply_target_guid=$2,reply_part='0' WHERE id=$1",
      [other.id, f.guid],
    );
    expect((await archive.findMessage(other.id))?.replyTo).toEqual({
      status: "unavailable",
    });
    f.set(1788000005000, { messageSummaryInfo: [{ retractedParts: [1] }] });
    await f.notify(1788000005000);
    await service.tick();
    expect(await archive.findMessage(f.id)).toMatchObject({
      revisionState: "partial",
      body: null,
      attachments: [],
    });
  });
  it("never revives partial text after multiple subsequent edits", async () => {
    const f = await fixture();
    f.set(1788000005000, { messageSummaryInfo: [{ retractedParts: [1] }] });
    await f.notify(1788000005000);
    await service.tick();
    for (const time of [1788000006000, 1788000007000]) {
      f.set(time);
      await f.notify(time);
      await service.tick();
      expect(await archive.findMessage(f.id)).toMatchObject({
        revisionState: "partial",
        body: null,
        attachments: [],
      });
    }
  });
  it("reports equal-time content conflicts instead of overwriting the archive", async () => {
    const f = await fixture();
    f.set(1788000005000);
    await f.notify(1788000005000);
    await service.tick();
    f.set(1788000005000, { text: "相同时间的冲突内容" });
    // A delayed older notification can observe conflicting current details.
    await f.notify(1788000004000);
    await service.tick();
    expect((await archive.findMessage(f.id))?.body).toBe("修改后");
    expect(
      (
        await db.query<{ reason: string }>(
          "SELECT reason FROM message_revision_jobs WHERE provider_message_id=$1 AND status='failed'",
          [f.guid],
        )
      ).rows[0]?.reason,
    ).toBe("same-time-conflict");
  });
  it("recovers an expired worker lease but does not exceed the retry limit", async () => {
    const f = await fixture();
    f.set(1788000005000);
    await f.notify(1788000005000);
    await db.query(
      "UPDATE message_revision_jobs SET status='running',lease_id=$2,lease_until=now()-interval '1 second',attempts=1 WHERE provider_message_id=$1",
      [f.guid, randomUUID()],
    );
    await service.tick();
    expect((await archive.findMessage(f.id))?.body).toBe("修改后");
    f.set(1788000006000);
    await f.notify(1788000006000);
    await db.query(
      "UPDATE message_revision_jobs SET status='running',lease_id=$2,lease_until=now()-interval '1 second',attempts=5 WHERE provider_message_id=$1 AND status='pending'",
      [f.guid, randomUUID()],
    );
    const reads = readDetail.mock.calls.length;
    await service.tick();
    expect(readDetail.mock.calls.length).toBe(reads);
    expect(
      (
        await db.query<{ reason: string }>(
          "SELECT reason FROM message_revision_jobs WHERE provider_message_id=$1 AND status='failed'",
          [f.guid],
        )
      ).rows[0]?.reason,
    ).toBe("attempts-exhausted");
  });
  it("waits for local archive arrival without fetching unknown content, and retries failures", async () => {
    const f = await fixture();
    const unknownGuid = `unknown-${randomUUID()}`;
    testGuids.add(unknownGuid);
    const n = adapter.normalize(
      {
        type: "updated-message",
        data: { guid: unknownGuid, dateEdited: 1788000005000 },
      },
      randomUUID(),
    );
    if (n.kind !== "revision") throw new Error("fixture");
    await service.enqueue(n.notification);
    await service.tick();
    expect(readDetail.mock.calls.some(([guid]) => guid === unknownGuid)).toBe(
      false,
    );
    const first = await db.query(
      "SELECT status,reason,attempts FROM message_revision_jobs WHERE provider_message_id=$1",
      [unknownGuid],
    );
    expect(first.rows[0]).toMatchObject({
      status: "pending",
      reason: "target-not-archived",
      attempts: 1,
    });
    // Simulate late archive arrival; this still does not create a workflow.
    await db.query("UPDATE messages SET provider_message_id=$2 WHERE id=$1", [
      f.id,
      unknownGuid,
    ]);
    await db.query(
      "UPDATE message_revision_jobs SET next_attempt_at=now() WHERE provider_message_id=$1",
      [unknownGuid],
    );
    await service.tick();
    expect(
      (
        await db.query<{ reason: string }>(
          "SELECT reason FROM message_revision_jobs WHERE provider_message_id=$1",
          [unknownGuid],
        )
      ).rows[0]?.reason,
    ).toBe("detail-or-apply-failed");
    f.set(1788000005000);
    details.set(unknownGuid, {
      ...details.get(f.guid)!,
      providerMessageId: unknownGuid,
    });
    await db.query(
      "UPDATE message_revision_jobs SET next_attempt_at=now() WHERE provider_message_id=$1",
      [unknownGuid],
    );
    await service.tick();
    expect((await archive.findMessage(f.id))?.body).toBe("修改后");
  });
  it("handles concurrent duplicate notifications once and does not revive retained-away content", async () => {
    const f = await fixture();
    f.set(1788000006000);
    const results = await Promise.all([
      f.notify(1788000006000),
      f.notify(1788000006000),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "duplicate",
      "ignored",
    ]);
    await service.tick();
    expect(
      (
        await db.query<{ revision_number: string }>(
          "SELECT revision_number FROM messages WHERE id=$1",
          [f.id],
        )
      ).rows[0]?.revision_number,
    ).toBe("1");
    await db.query(
      "UPDATE messages SET body=NULL,attachments='[]',content_redacted_at=now() WHERE id=$1",
      [f.id],
    );
    f.set(1788000007000);
    await f.notify(1788000007000);
    await service.tick();
    expect((await archive.findMessage(f.id))?.body).toBeNull();
  });
  it("still applies a content-shrinking retraction after monitoring is disabled", async () => {
    const f = await fixture();
    await db.query("UPDATE chats SET enabled=false WHERE provider_chat_id=$1", [
      f.chat,
    ]);
    f.set(1788000009000, {
      partCount: 0,
      messageSummaryInfo: [{ retractedParts: [0] }],
    });
    await f.notify(1788000009000);
    await service.tick();
    expect(
      (
        await db.query<{ revision_state: string }>(
          "SELECT revision_state FROM messages WHERE id=$1",
          [f.id],
        )
      ).rows[0]?.revision_state,
    ).toBe("retracted");
  });
  it("revision ingestion never returns an automation envelope", async () => {
    const f = await fixture();
    const ingestion = new IngestionService(
      adapter,
      archive,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    const result = await ingestion.ingest(
      {
        type: "updated-message",
        data: { guid: f.guid, dateEdited: 1788000003000 },
      },
      randomUUID(),
    );
    expect(result.automationEnvelope).toBeNull();
    expect(result.contextTrigger).toBeUndefined();
  });
});
