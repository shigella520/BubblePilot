import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Client, Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PostgresImageSummaryRepository } from "../modules/ai/postgres-image-summary-repository.js";
import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";
import { PostgresAiRepository } from "../modules/ai/postgres-ai-repository.js";
import { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import { OpenAiCompatibleClient } from "../modules/ai/openai-compatible-client.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import {
  ImageSummaryService,
  imageSummaryStrategyFingerprint,
} from "../modules/ai/image-summary-service.js";
import type { NativeImageInputService } from "../modules/ai/native-image-input.js";
import type {
  ImageSummaryJob,
  ImageSummarySource,
} from "../modules/ai/image-summary-types.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import { groupAttachmentWebhook } from "./fixtures/bluebubbles.js";

const url = process.env.TEST_DATABASE_URL;
const hash = "sha256:fictional-identical-image";
const fingerprint = imageSummaryStrategyFingerprint("high");

describe.runIf(!!url)(
  "image summary content reuse (isolated PostgreSQL)",
  () => {
    const databaseName = `image_reuse_${randomUUID().replaceAll("-", "")}_test`;
    let admin: Client;
    let db: Pool;
    let repository: PostgresImageSummaryRepository;
    let archive: PostgresArchiveRepository;
    let ai: PostgresAiRepository;
    let providerId: string;
    let legacy: Awaited<ReturnType<typeof fixture>>;

    async function fixture(
      chat = `fictional-chat-${randomUUID()}`,
      link = false,
    ) {
      const payload = groupAttachmentWebhook();
      payload.data.guid = `fictional-image-${randomUUID()}`;
      payload.data.chats[0]!.guid = chat;
      payload.data.attachments[0]!.guid = `fictional-attachment-${randomUUID()}`;
      const normalized = new BlueBubblesWebhookAdapter().normalize(
        payload,
        randomUUID(),
      );
      if (normalized.kind !== "message") throw new Error("Invalid fixture");
      const saved = await archive.ingestMessage(normalized.envelope, true);
      const messageId = saved.messageId!;
      await archive.recordAutomationOutcome(
        "bluebubbles",
        normalized.envelope.eventId,
        "not-evaluated",
      );
      let source: ImageSummarySource = {
        sourceType: "attachment",
        sourceKey: payload.data.attachments[0]!.guid,
        attachmentRef: "fictional-image-ref",
        attachment: normalized.envelope.message.attachments[0]!,
      };
      if (link) {
        const preview = {
          source: "open-graph" as const,
          url: "https://example.test/article",
          originalUrl: null,
          title: "Fictional article",
          summary: null,
          siteName: null,
          imageAvailable: true,
          imageUrl: "https://example.test/cover.png",
          imageSource: "open-graph" as const,
          iconAvailable: false,
        };
        await db.query<Record<string, unknown>>(
          "UPDATE messages SET link_previews=$2 WHERE id=$1",
          [messageId, JSON.stringify([preview])],
        );
        source = {
          sourceType: "link-preview",
          sourceKey: preview.imageUrl,
          attachmentRef: "fictional-link-ref",
          preview,
        };
      }
      await repository.enqueue(messageId, source);
      return { messageId, chat, source };
    }

    async function claim(owner = "worker-a"): Promise<ImageSummaryJob> {
      const job = await repository.claimNext({
        leaseOwner: owner,
        leaseMs: 600_000,
        maxAttempts: 3,
      });
      if (!job) throw new Error("Missing fixture job");
      return job;
    }
    function content(
      job: ImageSummaryJob,
      owner = "worker-a",
      imageHash = hash,
      strategy = fingerprint,
    ) {
      return {
        jobId: job.id,
        leaseOwner: owner,
        imageContentHash: imageHash,
        strategyFingerprint: strategy,
      };
    }
    async function generate(job: ImageSummaryJob, owner = "worker-a") {
      const input = content(job, owner);
      const lease = await repository.acquireContentLease(input);
      if (lease.status !== "acquired") throw new Error("Missing content lease");
      const completion = {
        ...input,
        contentLeaseToken: lease.token,
        summary: "虚构的蓝色方块。",
        providerId,
        providerName: "Fictional vision",
        model: "fictional-vision",
        durationMs: 12,
      };
      expect(await repository.complete(completion)).toBe(true);
      await repository.releaseContentLease({
        jobId: job.id,
        token: lease.token,
      });
      return completion;
    }
    function service(
      fetchImplementation: typeof fetch = () =>
        Promise.resolve(
          new Response(JSON.stringify({ output_text: "虚构的蓝色方块。" }), {
            headers: { "content-type": "application/json" },
          }),
        ),
    ) {
      const secrets = new EnvironmentSecretResolver({
        FICTIONAL_IMAGE_KEY: "fictional-secret",
      });
      return new ImageSummaryService(
        repository,
        ai,
        new AiRoutingService(
          ai,
          new OpenAiCompatibleClient(secrets, fetchImplementation),
          secrets,
        ),
        {
          loadForSummary: vi.fn().mockResolvedValue({
            status: "succeeded",
            contentHash: hash,
            part: {
              type: "image",
              dataUrl: "data:image/png;base64,ZmFrZQ==",
              detail: "high",
              label: "fictional image",
            },
          }),
        } as unknown as NativeImageInputService,
      );
    }
    async function view(messageId: string) {
      return (await repository.listForMessageIds([messageId])).get(
        messageId,
      )![0]!;
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: url });
      await admin.connect();
      await admin.query<Record<string, unknown>>(
        `CREATE DATABASE "${databaseName}"`,
      );
      const connection = new URL(url!);
      connection.pathname = `/${databaseName}`;
      const isolatedUrl = connection.toString();
      db = new Pool({ connectionString: isolatedUrl });
      const files = (await readdir(new URL("../migrations/", import.meta.url)))
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const file of files.filter((f) => f < "0076")) {
        await db.query<Record<string, unknown>>(
          await readFile(
            new URL(`../migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
      }
      repository = new PostgresImageSummaryRepository(isolatedUrl);
      archive = new PostgresArchiveRepository(isolatedUrl);
      ai = new PostgresAiRepository(isolatedUrl);
      legacy = await fixture();
      await db.query<Record<string, unknown>>(
        "UPDATE message_image_summaries SET status='succeeded',summary='虚构旧摘要',image_content_hash=$1,generated_at=now()",
        [hash],
      );
      await db.query<Record<string, unknown>>(
        await readFile(
          new URL(
            "../migrations/0076_image_summary_reuse.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const provider = await ai.createProvider({
        name: "Fictional vision",
        apiKind: "responses",
        baseUrl: "https://ai.example.test/v1",
        model: "fictional-vision",
        secretRef: "FICTIONAL_IMAGE_KEY",
        parameters: {},
        requestTimeoutMs: 5000,
        enabled: true,
        capabilities: {
          imageInput: true,
          functionCalling: false,
          hostedWebSearch: false,
        },
      });
      if (provider.status !== "ok") throw new Error("Provider fixture");
      providerId = provider.value.id;
      await ai.updateProviderCapabilityProbe(providerId, {
        imageInput: "verified",
        functionCalling: "unknown",
        hostedWebSearch: "unknown",
        checkedAt: new Date().toISOString(),
      });
      await ai.createRoute({
        name: "Fictional image route",
        providerIds: [providerId],
        enabled: true,
        fallbackEnabled: false,
        retryPolicy: { maxRounds: 1, initialDelayMs: 0 },
        degradePolicy: { failureThreshold: 10, cooldownMs: 60000 },
      });
    }, 30_000);
    afterEach(async () => {
      await db.query<Record<string, unknown>>(
        "TRUNCATE message_image_summaries CASCADE",
      );
      await db.query<Record<string, unknown>>(
        "TRUNCATE ai_provider_attempts,ai_route_traces",
      );
    });
    afterAll(async () => {
      await Promise.all([
        repository?.close(),
        archive?.close(),
        ai?.close(),
        db?.end(),
      ]);
      await vi.waitFor(
        async () => {
          const active = await admin.query<{ count: string }>(
            "SELECT count(*) FROM pg_stat_activity WHERE datname=$1",
            [databaseName],
          );
          expect(active.rows[0]!.count).toBe("0");
        },
        { timeout: 5000 },
      );
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    });

    it("preserves legacy results during migration but never reuses them", async () => {
      expect(await view(legacy.messageId)).toMatchObject({
        resultOrigin: "legacy",
        summary: "虚构旧摘要",
        providerAttemptCount: 0,
      });
      await fixture(legacy.chat);
      const job = await claim();
      expect(await repository.reuse({ ...content(job), durationMs: 1 })).toBe(
        false,
      );
      const row = await db.query<Record<string, unknown>>(
        "SELECT strategy_fingerprint FROM message_image_summaries WHERE message_id=$1",
        [legacy.messageId],
      );
      expect(row.rows[0]!.strategy_fingerprint).toBeNull();
    });

    it("reuses attachment bytes for a link image without an available route or extra attempts/traces", async () => {
      const first = await fixture();
      const job = await claim();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ output_text: "虚构蓝色方块。" }), {
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      const worker = service(fetcher);
      expect(await worker.process(job, "worker-a")).toBe(true);
      const second = await fixture(first.chat, true);
      vi.spyOn(ai, "listRoutes").mockResolvedValue([]);
      expect(await worker.process(await claim(), "worker-a")).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const original = await view(first.messageId);
      expect(original).toMatchObject({
        resultOrigin: "model",
        providerAttemptCount: 1,
      });
      expect(await view(second.messageId)).toMatchObject({
        resultOrigin: "cache",
        providerAttemptCount: 0,
        generatedAt: original.generatedAt,
        summary: original.summary,
        providerName: original.providerName,
      });
      expect((await view(second.messageId)).reusedAt).not.toBeNull();
      expect(
        (
          await db.query<Record<string, unknown>>(
            "SELECT count(*) FROM ai_route_traces",
          )
        ).rows[0]!.count,
      ).toBe("1");
    });

    it("isolates chats, bytes and generation strategies", async () => {
      const first = await fixture();
      await generate(await claim());
      const differentChat = await fixture();
      const other = await claim();
      expect(await repository.reuse({ ...content(other), durationMs: 0 })).toBe(
        false,
      );
      expect(differentChat.chat).not.toBe(first.chat);
      await fixture(first.chat);
      const sameChat = await claim("worker-b");
      expect(
        await repository.reuse({
          ...content(sameChat, "worker-b", "sha256:different"),
          durationMs: 0,
        }),
      ).toBe(false);
      expect(
        await repository.reuse({
          ...content(
            sameChat,
            "worker-b",
            hash,
            imageSummaryStrategyFingerprint("low"),
          ),
          durationMs: 0,
        }),
      ).toBe(false);
      expect(
        await repository.reuse({
          ...content(sameChat, "worker-b"),
          durationMs: 0,
        }),
      ).toBe(true);
    });

    it("coordinates concurrent workers and refunds contention without spending a model attempt", async () => {
      const first = await fixture();
      const firstJob = await claim();
      const second = await fixture(first.chat);
      const secondJob = await claim("worker-b");
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        entered();
        await gate;
        return new Response(JSON.stringify({ output_text: "虚构蓝色方块。" }), {
          headers: { "content-type": "application/json" },
        });
      });
      const firstRun = service(fetcher).process(firstJob, "worker-a");
      await started;
      try {
        expect(await service(fetcher).process(secondJob, "worker-b")).toBe(
          false,
        );
        const waiting = await db.query<Record<string, unknown>>(
          "SELECT status,attempt_count,content_wait_count,next_attempt_at>now() future FROM message_image_summaries WHERE id=$1",
          [secondJob.id],
        );
        expect(waiting.rows[0]!).toEqual({
          status: "pending",
          attempt_count: 0,
          content_wait_count: 1,
          future: true,
        });
      } finally {
        release();
      }
      expect(await firstRun).toBe(true);
      await db.query<Record<string, unknown>>(
        "UPDATE message_image_summaries SET next_attempt_at=now() WHERE id=$1",
        [secondJob.id],
      );
      expect(
        await service(fetcher).process(await claim("worker-b"), "worker-b"),
      ).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await view(second.messageId)).toMatchObject({
        resultOrigin: "cache",
        attemptCount: 1,
        providerAttemptCount: 0,
      });
      expect(
        (
          await db.query<Record<string, unknown>>(
            "SELECT count(*) FROM image_summary_content_leases",
          )
        ).rows[0]!.count,
      ).toBe("0");
    });

    it("fences expired owners, renews both leases and recovers abandoned jobs", async () => {
      await fixture();
      const job = await claim();
      const old = await repository.acquireContentLease(content(job));
      if (old.status !== "acquired") throw new Error("lease");
      expect(
        await repository.renewLease({
          jobId: job.id,
          leaseOwner: "worker-a",
          leaseMs: 300000,
        }),
      ).toBe(true);
      await db.query<Record<string, unknown>>(
        "UPDATE message_image_summaries SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
        [job.id],
      );
      await db.query<Record<string, unknown>>(
        "UPDATE image_summary_content_leases SET expires_at=now()-interval '1 second'",
      );
      const recovered = await claim("worker-b");
      expect(recovered).toMatchObject({ id: job.id, attemptCount: 2 });
      const lease = await repository.acquireContentLease(
        content(recovered, "worker-b"),
      );
      if (lease.status !== "acquired") throw new Error("lease");
      expect(
        await repository.canGenerate({
          ...content(job),
          contentLeaseToken: old.token,
        }),
      ).toBe(false);
      expect(
        await repository.complete({
          ...content(job),
          contentLeaseToken: old.token,
          summary: "迟到结果",
          providerId,
          providerName: "fictional",
          model: "fictional",
          durationMs: 1,
        }),
      ).toBe(false);
      await repository.releaseContentLease({ jobId: job.id, token: old.token });
      expect(
        await repository.canGenerate({
          ...content(recovered, "worker-b"),
          contentLeaseToken: lease.token,
        }),
      ).toBe(true);
      await db.query<Record<string, unknown>>(
        "UPDATE image_summary_content_leases SET expires_at=now()-interval '1 second'",
      );
      expect(
        await repository.renewLease({
          jobId: job.id,
          leaseOwner: "worker-b",
          leaseMs: 300000,
        }),
      ).toBe(false);
    });

    it("does not cache failures and preserves failed attempt history when a later cache hit completes", async () => {
      const first = await fixture();
      const failedJob = await claim();
      expect(
        await service(() =>
          Promise.resolve(new Response("{}", { status: 503 })),
        ).process(failedJob, "worker-a"),
      ).toBe(false);
      expect((await view(first.messageId)).providerAttemptCount).toBe(1);
      expect(
        (
          await db.query<Record<string, unknown>>(
            "SELECT count(*) FROM image_summary_content_leases",
          )
        ).rows[0]!.count,
      ).toBe("0");
      // Keep the failed job pending in the future while another message produces the cache entry.
      await db.query<Record<string, unknown>>(
        "UPDATE message_image_summaries SET next_attempt_at=now()+interval '1 hour' WHERE id=$1",
        [failedJob.id],
      );
      await fixture(first.chat);
      const other = await claim("worker-b");
      expect(
        await repository.reuse({
          ...content(other, "worker-b"),
          durationMs: 0,
        }),
      ).toBe(false);
      await generate(other, "worker-b");
      await db.query<Record<string, unknown>>(
        "UPDATE message_image_summaries SET next_attempt_at=now() WHERE id=$1",
        [failedJob.id],
      );
      expect(await service().process(await claim(), "worker-a")).toBe(true);
      expect(await view(first.messageId)).toMatchObject({
        resultOrigin: "cache",
        providerAttemptCount: 1,
        attemptCount: 2,
      });
      expect(
        (
          await db.query<Record<string, unknown>>(
            "SELECT count(*) FROM ai_route_traces WHERE background_operation_id=$1",
            [failedJob.id],
          )
        ).rows[0]!.count,
      ).toBe("1");
    });

    it.each(["source", "target"] as const)(
      "rechecks a concurrently invalidated %s after acquiring message locks",
      async (which) => {
        const first = await fixture();
        await generate(await claim());
        const second = await fixture(first.chat);
        const job = await claim();
        const lock = await db.connect();
        await lock.query("BEGIN");
        await lock.query(
          "UPDATE messages SET revision_number=1,revision_state='retracted' WHERE id=$1",
          [which === "source" ? first.messageId : second.messageId],
        );
        const pending = repository.reuse({ ...content(job), durationMs: 0 });
        try {
          // Observe the real blocked SQL instead of depending on a timing sleep.
          await vi.waitFor(async () => {
            const blocked = await db.query<Record<string, unknown>>(
              "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM messages%' ",
            );
            expect(blocked.rowCount).toBeGreaterThan(0);
          });
        } finally {
          await lock.query("COMMIT");
          lock.release();
        }
        expect(await pending).toBe(false);
        expect((await view(second.messageId)).summary).toBeNull();
      },
    );

    it("keeps a valid copied result after source cleanup, then clears target provenance on its own retention", async () => {
      const first = await fixture();
      await generate(await claim());
      const second = await fixture(first.chat);
      expect(
        await repository.reuse({ ...content(await claim()), durationMs: 0 }),
      ).toBe(true);
      await db.query<Record<string, unknown>>(
        "UPDATE messages SET created_at=now()-interval '10 days' WHERE id=$1",
        [first.messageId],
      );
      const retention = {
        before: new Date(Date.now() - 86400000),
        now: new Date(),
        limit: 100,
        retentionDays: 1,
        correlationId: randomUUID(),
      };
      expect(await archive.redactExpiredMessageContent(retention)).toBe(1);
      expect(await view(first.messageId)).toMatchObject({
        summary: null,
        resultOrigin: null,
      });
      expect(await view(second.messageId)).toMatchObject({
        resultOrigin: "cache",
        summary: "虚构的蓝色方块。",
      });
      await db.query<Record<string, unknown>>(
        "UPDATE messages SET created_at=now()-interval '10 days' WHERE id=$1",
        [second.messageId],
      );
      expect(await archive.redactExpiredMessageContent(retention)).toBe(1);
      const row = await db.query<Record<string, unknown>>(
        "SELECT summary,strategy_fingerprint,reused_from_id,reused_at,image_content_hash FROM message_image_summaries WHERE message_id=$1",
        [second.messageId],
      );
      expect(Object.values(row.rows[0]!)).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
    });

    it("uses the partial reuse index with a fictional image catalogue", async () => {
      const f = await fixture();
      await db.query<Record<string, unknown>>(
        `INSERT INTO message_image_summaries(id,message_id,source_type,source_key,attachment_ref,status,
      summary,image_content_hash,strategy_fingerprint,generated_at)
      SELECT gen_random_uuid(),$1,'attachment','fixture-'||n,'fixture-'||n,'succeeded',
      '虚构索引测试摘要','sha256:fixture-'||n,$2,now() FROM generate_series(1,2000) n`,
        [f.messageId, fingerprint],
      );
      await db.query<Record<string, unknown>>(
        "ANALYZE message_image_summaries",
      );
      const plan = await db.query<Record<string, unknown>>(
        `EXPLAIN (ANALYZE, FORMAT JSON) SELECT s.id FROM message_image_summaries s
      JOIN messages m ON m.id=s.message_id
      WHERE s.image_content_hash='sha256:fixture-1000' AND s.strategy_fingerprint=$1
        AND s.status='succeeded' AND length(s.summary)>0 AND m.chat_id=(SELECT chat_id FROM messages WHERE id=$2)
        AND m.revision_number=0 AND m.content_redacted_at IS NULL
      ORDER BY s.generated_at DESC,s.id LIMIT 1`,
        [fingerprint, f.messageId],
      );
      expect(JSON.stringify(plan.rows)).toContain(
        "message_image_summaries_reuse_idx",
      );
    });

    it("cache completion triggers the existing memory invalidation and incremental queue", async () => {
      const first = await fixture();
      await generate(await claim());
      const second = await fixture(first.chat);
      const job = await claim();
      const chatId = (
        await db.query<Record<string, unknown>>(
          "SELECT chat_id FROM messages WHERE id=$1",
          [second.messageId],
        )
      ).rows[0]!.chat_id;
      const generation = randomUUID();
      await db.query<Record<string, unknown>>(
        "INSERT INTO memory_settings(id,enabled,config) VALUES(1,true,'{}') ON CONFLICT(id) DO UPDATE SET enabled=true",
      );
      await db.query<Record<string, unknown>>(
        "INSERT INTO memory_generations(id,config,identity,status) VALUES($1,'{}','fictional','active')",
        [generation],
      );
      await db.query<Record<string, unknown>>(
        "INSERT INTO memory_chats(chat_id,enabled,from_index) VALUES($1,true,0)",
        [chatId],
      );
      expect(await repository.reuse({ ...content(job), durationMs: 0 })).toBe(
        true,
      );
      expect(
        (
          await db.query<Record<string, unknown>>(
            "SELECT count(*) FROM memory_jobs WHERE chat_id=$1 AND generation_id=$2 AND status='queued'",
            [chatId, generation],
          )
        ).rows[0]!.count,
      ).toBe("1");
    });
  },
);
