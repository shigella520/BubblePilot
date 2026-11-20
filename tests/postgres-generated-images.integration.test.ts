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
import { pluginZip } from "./support/plugin-zip.js";
import { animatedGif } from "./support/animated-gif.js";
import { replyFileTypes } from "../modules/generated-images/image-policy.js";
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
  it("persists generic files with original names, sends bytes once, and reads legacy PNG keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-artifacts-"));
    const store = new GeneratedImageStore(pool, root);
    const run = await execution();
    const owner = {
      ...run,
      nodeId: "ai",
      runId: randomUUID(),
      pluginId: randomUUID(),
      server: "fictional",
    };
    const send = vi
      .fn<(command: SendAttachmentCommand) => Promise<DeliveryResult>>()
      .mockResolvedValue({
        status: "confirmed",
        providerMessageId: "fictional-file",
      });
    const gateway = {
      sendReply: vi.fn().mockResolvedValue({
        status: "confirmed",
        providerMessageId: "fictional-text",
      }),
      sendAttachment: send,
    };
    const delivery = new GeneratedImageDelivery(
      pool,
      store,
      gateway,
      new SettingsCipher("fictional-key-longer-than-thirty-two"),
    );
    try {
      await store.init();
      const fixtures = [
        ["动画.gif", await animatedGif()],
        ["report.txt", Buffer.from("fictional result")],
        ["report.md", Buffer.from("# fictional")],
        ["report.csv", Buffer.from("name,count\nfictional,3\n")],
        ["report.pdf", Buffer.from("%PDF-1.7\nfictional\n%%EOF")],
        [
          "report.xlsx",
          pluginZip({
            "[Content_Types].xml":
              '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
            "xl/workbook.xml":
              '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
          }),
        ],
        ["report.zip", pluginZip({ "result.txt": "fictional" })],
      ] as const;
      for (const [filename, bytes] of fixtures) {
        const asset = await store.save(
          owner,
          bytes,
          new AbortController().signal,
          { filename, allowedTypes: replyFileTypes },
        );
        expect(asset.filename).toBe(filename);
        if (filename.endsWith(".gif")) {
          expect(asset).toMatchObject({
            width: 8,
            height: 6,
            mime_type: "image/gif",
            file_type: "gif",
          });
          await expect(
            pool.query(
              "UPDATE generated_image_artifacts SET mime_type='image/png' WHERE id=$1",
              [asset.id],
            ),
          ).rejects.toThrow();
          await expect(
            pool.query(
              "UPDATE generated_image_artifacts SET width=NULL WHERE id=$1",
              [asset.id],
            ),
          ).rejects.toThrow();
          await expect(
            pool.query(
              "UPDATE generated_image_artifacts SET size=8388609 WHERE id=$1",
              [asset.id],
            ),
          ).rejects.toThrow();
        } else expect(asset.width).toBeNull();
        const restored = await new GeneratedImageStore(pool, root).read(
          asset.id,
          run.executionId,
        );
        expect(restored.bytes).toEqual(bytes);
        const input = {
          ...run,
          nodeId: filename,
          text: "fictional result",
          image: store.ref(asset),
        };
        await delivery.deliver(input, randomUUID());
        const count = send.mock.calls.length;
        await delivery.deliver(input, randomUUID());
        expect(send).toHaveBeenCalledTimes(count);
        expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
          filename,
          mimeType: asset.mime_type,
          bytes,
        });
      }
      const png = await sharp({
        create: { width: 20, height: 10, channels: 3, background: "red" },
      })
        .png()
        .toBuffer();
      const legacy = await store.save(owner, png, new AbortController().signal);
      const oldKey = legacy.storage_key.replace(/\.file$/, ".png");
      await writeFile(join(root, oldKey), png, { mode: 0o600 });
      await pool.query(
        "UPDATE generated_image_artifacts SET storage_key=$2 WHERE id=$1",
        [legacy.id, oldKey],
      );
      expect((await store.read(legacy.id, run.executionId)).bytes).toEqual(png);
      await pool.query(
        "UPDATE generated_image_artifacts SET expires_at=now()-interval '1 second' WHERE execution_id=$1",
        [run.executionId],
      );
      await store.cleanup();
      await expect(store.read(legacy.id, run.executionId)).rejects.toThrow(
        "GENERATED_IMAGE_UNAVAILABLE",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("migrates 0073 PNG rows through 0074 and 0075 without changing their identities", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const schema = `artifact_migration_${randomUUID().replaceAll("-", "")}`;
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query(
        "CREATE TABLE workflow_executions(id uuid PRIMARY KEY); CREATE TABLE outbound_deliveries(id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN ('text','meme')))",
      );
      await client.query(
        await readFile("migrations/0073_generated_image_replies.sql", "utf8"),
      );
      const id = randomUUID(),
        executionId = randomUUID();
      await client.query("INSERT INTO workflow_executions VALUES($1)", [
        executionId,
      ]);
      await client.query(
        "INSERT INTO generated_image_artifacts(id,execution_id,node_id,run_id,plugin_id,server,provider_chat_id,storage_key,sha256,size,width,height,state,expires_at) VALUES($1,$2,'ai',$3,$4,'fixture','chat','old.png',$5,10,20,10,'bound',now()+interval '1 day')",
        [id, executionId, randomUUID(), randomUUID(), "a".repeat(64)],
      );
      await client.query(
        await readFile(
          "migrations/0074_generated_attachment_replies.sql",
          "utf8",
        ),
      );
      await client.query(
        await readFile("migrations/0075_generated_gif_replies.sql", "utf8"),
      );
      expect(
        (
          await client.query(
            "SELECT id,filename,mime_type,file_type,width,height,storage_key FROM generated_image_artifacts WHERE id=$1",
            [id],
          )
        ).rows[0],
      ).toEqual({
        id,
        filename: "chart.png",
        mime_type: "image/png",
        file_type: "png",
        width: 20,
        height: 10,
        storage_key: "old.png",
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
