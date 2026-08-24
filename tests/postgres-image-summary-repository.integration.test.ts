import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";
import { PostgresAiRepository } from "../modules/ai/postgres-ai-repository.js";
import { PostgresImageSummaryRepository } from "../modules/ai/postgres-image-summary-repository.js";
import { attachmentImageReference } from "../modules/ai/image-reference.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import { groupAttachmentWebhook } from "./fixtures/bluebubbles.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(testDatabaseUrl !== undefined)(
  "PostgresImageSummaryRepository",
  () => {
    let repository: PostgresImageSummaryRepository;
    let archive: PostgresArchiveRepository;
    let ai: PostgresAiRepository;

    beforeAll(() => {
      repository = new PostgresImageSummaryRepository(testDatabaseUrl ?? "");
      archive = new PostgresArchiveRepository(testDatabaseUrl ?? "");
      ai = new PostgresAiRepository(testDatabaseUrl ?? "");
    });

    afterAll(async () => {
      await Promise.all([repository.close(), archive.close(), ai.close()]);
    });

    it("deduplicates, leases, retries, and commits one attachment summary", async () => {
      const suffix = randomUUID();
      const payload = groupAttachmentWebhook();
      payload.data.guid = `image-summary-message-${suffix}`;
      payload.data.chats[0]!.guid = `iMessage;+;image-summary-${suffix}`;
      payload.data.attachments[0]!.guid = `image-summary-attachment-${suffix}`;
      const normalized = new BlueBubblesWebhookAdapter().normalize(
        payload,
        randomUUID(),
      );
      expect(normalized.kind).toBe("message");
      if (normalized.kind !== "message") return;
      const ingested = await archive.ingestMessage(normalized.envelope, true);
      expect(ingested.messageId).not.toBeNull();
      if (ingested.messageId === null) return;
      const attachment = normalized.envelope.message.attachments[0]!;
      const source = {
        sourceType: "attachment" as const,
        sourceKey: attachment.providerAttachmentId,
        attachmentRef: attachmentImageReference(
          normalized.envelope.message.providerMessageId,
          0,
        ),
        attachment,
      };

      await expect(
        repository.enqueue(ingested.messageId, source),
      ).resolves.toBe(true);
      await expect(
        repository.enqueue(ingested.messageId, source),
      ).resolves.toBe(false);
      const first = await repository.claimNext({
        leaseOwner: "worker-a",
        leaseMs: 60_000,
        maxAttempts: 3,
      });
      expect(first).toMatchObject({
        attemptCount: 1,
        sourceKey: source.sourceKey,
      });
      if (first === null) return;
      await expect(
        repository.renewLease({
          jobId: first.id,
          leaseOwner: "worker-a",
          leaseMs: 60_000,
        }),
      ).resolves.toBe(true);
      await expect(
        repository.claimNext({
          leaseOwner: "worker-b",
          leaseMs: 60_000,
          maxAttempts: 3,
        }),
      ).resolves.toBeNull();
      await repository.fail({
        jobId: first.id,
        leaseOwner: "worker-a",
        status: "pending",
        errorCode: "IMAGE_SUMMARY_TEMPORARY_FAILURE",
        durationMs: 8,
        nextAttemptAt: new Date(0),
      });
      const second = await repository.claimNext({
        leaseOwner: "worker-b",
        leaseMs: 60_000,
        maxAttempts: 3,
      });
      expect(second).toMatchObject({ id: first.id, attemptCount: 2 });
      if (second === null) return;

      const provider = await ai.createProvider({
        name: `Image summary provider ${suffix}`,
        apiKind: "responses",
        baseUrl: "https://ai.example.test/v1",
        model: "fictional-vision",
        secretRef: "FICTIONAL_IMAGE_SUMMARY_KEY",
        parameters: {},
        requestTimeoutMs: 30_000,
        enabled: true,
      });
      expect(provider.status).toBe("ok");
      if (provider.status !== "ok") return;
      await expect(
        repository.complete({
          jobId: second.id,
          leaseOwner: "worker-b",
          imageContentHash: "sha256:fictional-image-content",
          summary: "虚构图片摘要。",
          providerId: provider.value.id,
          providerName: provider.value.name,
          model: provider.value.model,
          durationMs: 12,
        }),
      ).resolves.toBe(true);

      const summaries = await repository.listForProviderMessageIds([
        normalized.envelope.message.providerMessageId,
      ]);
      expect(
        summaries.get(normalized.envelope.message.providerMessageId),
      ).toMatchObject([
        {
          attachmentRef: source.attachmentRef,
          status: "succeeded",
          summary: "虚构图片摘要。",
          attemptCount: 2,
        },
      ]);
    });
  },
);
