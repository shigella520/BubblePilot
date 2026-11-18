import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { GeneratedImageStore } from "../modules/generated-images/image-store.js";
import { GeneratedImageDelivery } from "../modules/generated-images/image-delivery.js";
import { SettingsCipher } from "../modules/integrations/bluebubbles/settings-cipher.js";
import { PostgresWorkflowRepository } from "../modules/workflow/postgres-workflow-repository.js";
import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";
import { parseWorkflowDefinition } from "../modules/workflow/workflow-definition.js";
import { parseTriggerConditions } from "../modules/workflow/trigger-matcher.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";
import { Pool } from "pg";
import type {
  SendAttachmentCommand,
  SendReplyCommand,
  DeliveryResult,
} from "../modules/integrations/bluebubbles/reply-gateway.js";
const url = process.env.TEST_DATABASE_URL;
describe.runIf(!!url)("generated PNG persistence and delivery", () => {
  const pool = new Pool({ connectionString: url ?? "" });
  const workflow = new PostgresWorkflowRepository(url ?? ""),
    archive = new PostgresArchiveRepository(url ?? "");
  afterAll(async () => {
    await Promise.all([workflow.close(), archive.close(), pool.end()]);
  });
  async function execution() {
    const chatId = `fictional-images-${randomUUID()}`;
    const definition = parseWorkflowDefinition({
      schemaVersion: "1",
      name: "Fictional image test",
      startNodeId: "done",
      nodes: [
        {
          id: "done",
          type: "end",
          version: 1,
          config: { result: "succeeded" },
        },
      ],
    });
    const version = await workflow.createWorkflow(chatId, definition);
    await workflow.publishWorkflowVersion(version.workflowId, version.version);
    await workflow.createTrigger({
      name: chatId,
      workflowId: version.workflowId,
      workflowVersion: version.version,
      conditions: parseTriggerConditions({ chatIds: [chatId] }),
      includeFromMe: false,
      enabled: true,
    });
    const binding = (await workflow.listActiveTriggerBindings()).find(
      (t) => t.workflowId === version.workflowId,
    )!;
    const event = new BlueBubblesWebhookAdapter().normalize(
      newMessageWebhook({
        messageGuid: chatId,
        chatGuid: chatId,
        text: "fictional drawing",
      }),
      randomUUID(),
    );
    if (event.kind !== "message") throw new Error("fixture");
    await archive.ingestMessage(event.envelope, true);
    const run = await workflow.createExecution({
      envelope: event.envelope,
      trigger: binding,
    });
    await workflow.markExecutionRunning(run.execution.id, "ai");
    return { executionId: run.execution.id, chatId };
  }
  it("stages original bytes, survives restart, sends parts once, and retains ambiguous evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-generated-"));
    const store = new GeneratedImageStore(pool, root, 1024 * 1024, 30);
    try {
      await store.init();
      const owner = {
        ...(await execution()),
        nodeId: "ai",
        runId: randomUUID(),
        pluginId: randomUUID(),
        server: "fictional-sandbox",
      };
      const png = await sharp({
        create: { width: 80, height: 40, channels: 4, background: "#00aa88" },
      })
        .png()
        .toBuffer();
      const asset = await store.save(owner, png, new AbortController().signal);
      const duplicate = await store.save(
        owner,
        png,
        new AbortController().signal,
      );
      expect(duplicate.id).toBe(asset.id);
      expect((await store.read(asset.id, owner.executionId)).bytes).toEqual(
        png,
      );
      await expect(store.read(asset.id, randomUUID())).rejects.toThrow(
        "GENERATED_IMAGE_UNAVAILABLE",
      );
      const gateway = {
        sendReply: vi
          .fn<(command: SendReplyCommand) => Promise<DeliveryResult>>()
          .mockResolvedValue({
            status: "confirmed",
            providerMessageId: randomUUID(),
          }),
        sendAttachment: vi
          .fn<(command: SendAttachmentCommand) => Promise<DeliveryResult>>()
          .mockResolvedValue({
            status: "failed",
            code: "RATE_LIMIT",
            summary: "fictional",
            retryable: true,
          }),
      };
      const delivery = new GeneratedImageDelivery(
        pool,
        store,
        gateway,
        new SettingsCipher("x".repeat(32)),
      );
      const input = {
        ...owner,
        nodeId: "reply",
        text: "fictional caption",
        image: store.ref(asset),
      };
      const first = await delivery.deliver(input, randomUUID());
      expect(first.text?.status).toBe("confirmed");
      expect(first.image?.status).toBe("failed");
      gateway.sendAttachment.mockResolvedValue({
        status: "confirmed",
        providerMessageId: randomUUID(),
      });
      const restarted = new GeneratedImageDelivery(
        pool,
        new GeneratedImageStore(pool, root),
        gateway,
        new SettingsCipher("x".repeat(32)),
      );
      const [a, b] = await Promise.all([
        restarted.deliver(input, randomUUID()),
        restarted.deliver(input, randomUUID()),
      ]);
      expect([a.image?.status, b.image?.status]).toContain("confirmed");
      expect(gateway.sendReply).toHaveBeenCalledTimes(1);
      expect(gateway.sendAttachment).toHaveBeenCalledTimes(2);
      expect(
        (gateway.sendAttachment.mock.calls[0]?.[0] as { bytes: Buffer }).bytes,
      ).toEqual(png);
      await expect(
        delivery.plan({ ...input, nodeId: "second-reply" }),
      ).rejects.toThrow("GENERATED_IMAGE_UNAVAILABLE");
      const owner2 = {
        ...(await execution()),
        nodeId: "ai",
        runId: randomUUID(),
        pluginId: owner.pluginId,
        server: owner.server,
      };
      const asset2 = await store.save(
        owner2,
        png,
        new AbortController().signal,
      );
      gateway.sendAttachment.mockResolvedValue({
        status: "unknown",
        code: "RECEIPT_UNKNOWN",
        summary: "fictional",
      });
      const imageOnly = {
        ...owner2,
        nodeId: "reply",
        text: "",
        image: store.ref(asset2),
      };
      const unknown = await delivery.deliver(imageOnly, randomUUID());
      expect(unknown.text).toBeNull();
      expect(unknown.image?.status).toBe("unknown");
      const count = gateway.sendAttachment.mock.calls.length;
      await delivery.deliver(imageOnly, randomUUID());
      expect(gateway.sendAttachment).toHaveBeenCalledTimes(count);
      await pool.query(
        "UPDATE generated_image_artifacts SET expires_at=now()-interval '1 second' WHERE id=$1",
        [asset2.id],
      );
      await store.cleanup();
      expect((await store.list(owner2.executionId))[0]).toMatchObject({
        state: "deleted",
        deliveryStatus: "unknown",
      });
      await expect(readFile(join(root, asset2.storage_key))).rejects.toThrow();
      const owner3 = {
        ...(await execution()),
        nodeId: "ai",
        runId: randomUUID(),
        pluginId: owner.pluginId,
        server: owner.server,
      };
      const asset3 = await store.save(
        owner3,
        png,
        new AbortController().signal,
      );
      await writeFile(join(root, asset3.storage_key), Buffer.alloc(png.length));
      await expect(store.read(asset3.id, owner3.executionId)).rejects.toThrow(
        "IMAGE_HASH_MISMATCH",
      );
      await store.discard(owner3.runId);
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(store.save(owner3, png, cancelled.signal)).rejects.toThrow();
      await expect(
        new GeneratedImageStore(pool, root, 1).save(
          { ...owner3, runId: randomUUID() },
          png,
          new AbortController().signal,
        ),
      ).rejects.toThrow("IMAGE_STORAGE_FULL");
      // Recovering a sending lease never replays an uncertain provider call.
      const plan = await delivery.plan(input);
      await pool.query(
        "UPDATE outbound_deliveries SET status='sending',send_lease_until=now()-interval '1 second' WHERE id=$1",
        [plan.image_delivery_id],
      );
      await delivery.recover();
      expect(gateway.sendAttachment).toHaveBeenCalledTimes(count);
      expect(
        (
          await pool.query<{ status: string }>(
            "SELECT status FROM outbound_deliveries WHERE id=$1",
            [plan.image_delivery_id],
          )
        ).rows[0]?.status,
      ).toBe("unknown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
