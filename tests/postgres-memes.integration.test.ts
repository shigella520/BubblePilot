import type { MemeAsset } from "../modules/memes/meme-types.js";
import { randomUUID } from "node:crypto";
import { describe, it, expect, afterAll, vi } from "vitest";
import { PostgresMemeRepository } from "../modules/memes/postgres-meme-repository.js";
import { MemeDeliveryService } from "../modules/memes/meme-delivery-service.js";
import type { MemeService } from "../modules/memes/meme-service.js";
import { SettingsCipher } from "../modules/integrations/bluebubbles/settings-cipher.js";
import { PostgresWorkflowRepository } from "../modules/workflow/postgres-workflow-repository.js";
import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";
import { parseWorkflowDefinition } from "../modules/workflow/workflow-definition.js";
import { parseTriggerConditions } from "../modules/workflow/trigger-matcher.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";
import type { DeliveryResult } from "../modules/integrations/bluebubbles/reply-gateway.js";
const url = process.env.TEST_DATABASE_URL;
describe.runIf(!!url)("meme persistence and independent delivery", () => {
  const repo = new PostgresMemeRepository(url ?? "");
  const workflow = new PostgresWorkflowRepository(url ?? "");
  const archive = new PostgresArchiveRepository(url ?? "");
  afterAll(async () => {
    await Promise.all([repo.close(), workflow.close(), archive.close()]);
  });
  it("deduplicates concurrent uploads and preserves human edits against leased completions", async () => {
    const hash = randomUUID(),
      base = {
        name: `虚构开心${hash}`,
        description: "测试笑脸",
        tags: ["测试"],
        mimeType: "image/png",
        size: 10,
        width: 1,
        height: 1,
        hash,
        storageKey: randomUUID(),
      };
    const [a, b] = await Promise.all([
      repo.create(base),
      repo.create({ ...base, storageKey: randomUUID() }),
    ]);
    expect(a.asset.id).toBe(b.asset.id);
    expect([a, b].filter((r) => r.created)).toHaveLength(1);
    const job = await repo.claim("fixture-worker");
    expect(job?.memeId).toBe(a.asset.id);
    const edited = await repo.edit(a.asset.id, {
      name: base.name,
      description: base.description,
      tags: base.tags,
      summary: "人工写的摘要",
      expectedVersion: 1,
    });
    expect(edited?.version).toBe(2);
    expect(await repo.complete(job!, "自动候选摘要")).toBe(true);
    const current = await repo.get(a.asset.id);
    expect(current).toMatchObject({
      summary: "人工写的摘要",
      candidateSummary: "自动候选摘要",
    });
    expect(await repo.complete(job!, "迟到内容")).toBe(false);
    expect(await repo.adopt(a.asset.id, 1)).toBeNull();
    const adopted = await repo.adopt(a.asset.id, current!.version);
    expect(adopted?.summary).toBe("自动候选摘要");
    expect((await repo.search(hash, 5))[0]?.id).toBe(a.asset.id);
    expect(await repo.remove(a.asset.id, adopted!.version)).toBe(true);
    expect(await repo.search(hash, 5)).toEqual([]);
  });
  it("matches literal short words and browses enabled assets with a stable bounded order", async () => {
    const made: MemeAsset[] = [];
    for (const label of ["虚构小狗跳舞", "虚构猫咪招手", "虚构已停用"]) {
      made.push(
        (
          await repo.create({
            name: label,
            description: "",
            tags: [],
            mimeType: "image/png",
            size: 1,
            width: 1,
            height: 1,
            hash: randomUUID(),
            storageKey: randomUUID(),
          })
        ).asset,
      );
    }
    try {
      const disabled = made[2]!;
      await repo.edit(disabled.id, {
        name: disabled.name,
        description: "",
        tags: [],
        enabled: false,
        expectedVersion: disabled.version,
      });
      expect(
        (await repo.search("虚构小狗跳舞 不存在的词", 5)).some(
          (a: MemeAsset) => a.id === made[0]!.id,
        ),
      ).toBe(true);
      expect(
        (await repo.search("虚构小狗奔跑", 5)).some(
          (a: MemeAsset) => a.id === made[0]!.id,
        ),
      ).toBe(false);
      const browsed = await repo.search("", 2);
      expect(browsed.map((a) => a.id)).toEqual([made[1]!.id, made[0]!.id]);
      expect((await repo.search("", 2)).map((a) => a.id)).toEqual(
        browsed.map((a) => a.id),
      );
    } finally {
      for (const a of made)
        await repo.remove(a.id, (await repo.get(a.id))!.version);
    }
  });
  it("persists both parts before sending, retries only failed image and closes unknown without resending", async () => {
    const suffix = randomUUID();
    const image = await repo.create({
      name: "虚构表情",
      description: "",
      tags: [],
      mimeType: "image/png",
      size: 1,
      width: 1,
      height: 1,
      hash: "b".repeat(64) + suffix,
      storageKey: randomUUID(),
    });
    const definition = parseWorkflowDefinition({
      schemaVersion: "1",
      name: "虚构",
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
    const version = await workflow.createWorkflow(`meme-${suffix}`, definition);
    await workflow.publishWorkflowVersion(version.workflowId, version.version);
    await workflow.createTrigger({
      name: `meme-${suffix}`,
      workflowId: version.workflowId,
      workflowVersion: version.version,
      conditions: parseTriggerConditions({ chatIds: [suffix] }),
      includeFromMe: false,
      enabled: true,
    });
    const binding = (await workflow.listActiveTriggerBindings()).find(
      (t) => t.workflowId === version.workflowId,
    )!;
    const event = new BlueBubblesWebhookAdapter().normalize(
      newMessageWebhook({
        messageGuid: `meme-${suffix}`,
        chatGuid: suffix,
        text: "虚构测试",
      }),
      randomUUID(),
    );
    if (event.kind !== "message") throw new Error("fixture");
    await archive.ingestMessage(event.envelope, true);
    const execution = await workflow.createExecution({
      envelope: event.envelope,
      trigger: binding,
    });
    const calls: string[] = [];
    const gateway = {
      sendReply: vi.fn((): Promise<DeliveryResult> => {
        calls.push("text");
        return Promise.resolve({
          status: "confirmed",
          providerMessageId: "fake-text",
        });
      }),
      sendAttachment: vi.fn((): Promise<DeliveryResult> => {
        calls.push("image");
        return Promise.resolve({
          status: "failed",
          code: "RATE_LIMIT",
          summary: "fictional",
          retryable: true,
        });
      }),
    };
    const library = {
      repository: repo,
      files: { read: vi.fn().mockResolvedValue(Buffer.from("x")) },
    } as unknown as MemeService;
    const delivery = new MemeDeliveryService(
      repo.pool,
      library,
      gateway,
      new SettingsCipher("fictional-key"),
    );
    const input = {
      executionId: execution.execution.id,
      nodeId: "reply",
      chatId: suffix,
      text: "测试正文",
      meme: {
        id: image.asset.id,
        name: image.asset.name,
        hash: image.asset.hash,
      },
    };
    const plan = await delivery.plan(input);
    expect(
      (
        await repo.pool.query(
          "SELECT status FROM outbound_deliveries WHERE id=ANY($1::uuid[])",
          [[plan.textId, plan.memeId]],
        )
      ).rows,
    ).toEqual([{ status: "pending" }, { status: "pending" }]);
    const result = await delivery.deliver(input, "fixture");
    expect(result.text.status).toBe("confirmed");
    expect(result.image?.status).toBe("failed");
    expect(calls).toEqual(["text", "image"]);
    gateway.sendAttachment.mockResolvedValue({
      status: "unknown",
      code: "TIMEOUT",
      summary: "fictional timeout",
    });
    await delivery.retry(plan.memeId, "fixture");
    expect(calls.filter((c) => c === "text")).toHaveLength(1);
    expect(await delivery.retry(plan.memeId, "fixture")).toBeNull();
    expect(await delivery.close(plan.memeId)).toBe(true);
    expect((await delivery.list()).some((d) => d.id === plan.memeId)).toBe(
      false,
    );
    expect((await delivery.list(execution.execution.id))[0]?.status).toBe(
      "unknown",
    );

    expect((await repo.get(image.asset.id))?.usageCount).toBe(0);
    const countBefore = gateway.sendAttachment.mock.calls.length;
    await delivery.deliver(input, "fixture");
    expect(gateway.sendReply).toHaveBeenCalledTimes(1);
    expect(gateway.sendAttachment).toHaveBeenCalledTimes(countBefore);
    gateway.sendReply.mockResolvedValue({
      status: "failed",
      code: "REJECTED",
      summary: "fictional",
      retryable: false,
    });
    const rejected = await delivery.deliver(
      { ...input, nodeId: "text-failure" },
      "fixture",
    );
    expect(rejected.image).toBeNull();
    expect(gateway.sendAttachment).toHaveBeenCalledTimes(countBefore);
    gateway.sendReply.mockResolvedValue({
      status: "confirmed",
      providerMessageId: "fixture-recovered-text",
    });
    gateway.sendAttachment.mockResolvedValue({
      status: "confirmed",
      providerMessageId: "fixture-recovered-image",
    });
    const interrupted = await delivery.plan({
      ...input,
      nodeId: "interrupted",
    });
    await repo.pool.query(
      "UPDATE outbound_deliveries SET status='confirmed' WHERE id=$1",
      [interrupted.textId],
    );
    await repo.pool.query(
      "UPDATE outbound_deliveries SET status='sending',send_lease_until=now()-interval '1 minute' WHERE id=$1",
      [interrupted.memeId],
    );
    await delivery.recover();
    expect(
      (await delivery.list(execution.execution.id)).find(
        (d) => d.id === interrupted.memeId,
      )?.status,
    ).toBe("unknown");
    expect(await delivery.retry(interrupted.memeId, "fixture")).toBeNull();
    const resumable = await delivery.plan({ ...input, nodeId: "pending-plan" });
    await repo.pool.query(
      "UPDATE outbound_deliveries SET created_at=now()-interval '1 minute' WHERE id=ANY($1::uuid[])",
      [[resumable.textId, resumable.memeId]],
    );
    await delivery.recover();
    expect(
      (await delivery.list(execution.execution.id)).find(
        (d) => d.id === resumable.memeId,
      )?.status,
    ).toBe("confirmed");
    expect((await repo.get(image.asset.id))?.usageCount).toBe(1);
    const afterRecovery = gateway.sendAttachment.mock.calls.length;
    await delivery.recover();
    expect(gateway.sendAttachment).toHaveBeenCalledTimes(afterRecovery);
    expect((await repo.get(image.asset.id))?.usageCount).toBe(1);
    const late = await delivery.plan({ ...input, nodeId: "late-confirmation" });
    gateway.sendAttachment.mockImplementationOnce(async () => {
      await repo.pool.query(
        "UPDATE outbound_deliveries SET send_lease_until=now()-interval '1 second' WHERE id=$1",
        [late.memeId],
      );
      return { status: "confirmed", providerMessageId: "fixture-late" };
    });
    await delivery.deliver(
      { ...input, nodeId: "late-confirmation" },
      "fixture",
    );
    expect((await repo.get(image.asset.id))?.usageCount).toBe(1);
    await repo.pool.query("DELETE FROM meme_summary_jobs WHERE meme_id=$1", [
      image.asset.id,
    ]);
  });
});
