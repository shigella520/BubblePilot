import {
  memoryMessage,
  messageColumns,
  type MessageRow,
} from "./archive-message.js";
import { ChatQueryRepository } from "./chat-query-repository.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createPostgresPool } from "../shared/postgres-pool.js";
import { SettingsCipher } from "../integrations/bluebubbles/settings-cipher.js";
import { ApplicationError } from "../../app/errors.js";
import {
  contentHash,
  keywordTokens,
  type MemoryMessage,
  type MemoryChunk,
} from "./chunking.js";
import {
  defaultMemoryConfig,
  type Generation,
  type MemoryScope,
  type MemorySearch,
  type LatestChatMessages,
} from "./memory-types.js";
import type { EmbeddingConfig } from "./embedding-client.js";
import { estimateProgress, type ProgressSample } from "./job-progress.js";
export interface MemoryJob {
  request_key: string | null;
  progress_scope: string | null;
  progress_samples: ProgressSample[];
  progress_started_at: Date | null;
  progress_last_at: Date | null;
  id: string;
  chat_id: string;
  generation_id: string;
  from_index: string;
  through_index: string;
  cursor_index: string;
  lease_owner: string;
  attempts: number;
  range_from: Date | null;
  range_to: Date | null;
}
export interface Candidate {
  id: string;
  from_index: string;
  through_index: string;
}
export class MemoryRepository {
  readonly workerId = randomUUID();
  readonly pool: Pool;
  readonly cipher: SettingsCipher;
  readonly archiveQueries: ChatQueryRepository;
  constructor(databaseUrl: string, key: string) {
    this.pool = createPostgresPool(databaseUrl, 3, 5000);
    this.archiveQueries = new ChatQueryRepository(this.pool);
    this.cipher = new SettingsCipher(key);
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async ready(): Promise<boolean> {
    return (
      (
        await this.pool.query<{ ready: boolean }>(
          "SELECT to_regclass('memory_embeddings') IS NOT NULL AS ready",
        )
      ).rows[0]?.ready ?? false
    );
  }
  async settings() {
    const row = (
      await this.pool.query<{
        config: EmbeddingConfig;
        enabled: boolean;
        version: number;
        encrypted_secret: string | null;
      }>("SELECT * FROM memory_settings WHERE id=1")
    ).rows[0];
    return (
      row ?? {
        config: defaultMemoryConfig,
        enabled: false,
        version: 0,
        encrypted_secret: null,
      }
    );
  }
  async generations(): Promise<Generation[]> {
    return (
      await this.pool.query<Generation>(
        "SELECT * FROM memory_generations ORDER BY created_at DESC LIMIT 20",
      )
    ).rows;
  }
  async saveSettings(
    config: EmbeddingConfig,
    enabled: boolean,
    expectedVersion: number,
    secret: string | undefined,
    identity: string,
  ) {
    return this.transaction(async (db) => {
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtext('memory-settings'))",
      );
      const old = (
        await db.query<{
          version: number;
          config: EmbeddingConfig;
          encrypted_secret: string | null;
        }>("SELECT * FROM memory_settings WHERE id=1 FOR UPDATE")
      ).rows[0];
      if ((old?.version ?? 0) !== expectedVersion)
        throw new ApplicationError(
          "MEMORY_VERSION_CONFLICT",
          "Refresh memory settings before saving.",
          409,
        );
      const encrypted =
        secret === undefined
          ? (old?.encrypted_secret ?? null)
          : secret
            ? this.cipher.encrypt(secret)
            : null;
      const existing = (
        await db.query<Generation>(
          "SELECT * FROM memory_generations WHERE config=$1::jsonb AND identity=$2 AND status!='retired' ORDER BY created_at DESC LIMIT 1",
          [JSON.stringify(config), identity],
        )
      ).rows[0];
      if (!existing) {
        const active = await db.query(
          "SELECT 1 FROM memory_generations WHERE status='active'",
        );
        await db.query(
          "INSERT INTO memory_generations(id,config,encrypted_secret,identity,status) VALUES($1,$2,$3,$4,$5)",
          [
            randomUUID(),
            config,
            encrypted,
            identity,
            active.rowCount ? "building" : "active",
          ],
        );
      } else
        await db.query(
          "UPDATE memory_generations SET encrypted_secret=$2 WHERE id=$1",
          [existing.id, encrypted],
        );
      await db.query(
        `INSERT INTO memory_settings(id,enabled,config,encrypted_secret,version) VALUES(1,$1,$2,$3,1)
        ON CONFLICT(id) DO UPDATE SET enabled=$1,config=$2,encrypted_secret=$3,version=memory_settings.version+1`,
        [enabled, config, encrypted],
      );
    });
  }
  async authorize(chatId: string, enabled: boolean, version: number) {
    await this.transaction(async (db) => {
      const chat = (
        await db.query<{ next_message_index: string }>(
          "SELECT next_message_index FROM chats WHERE id=$1 AND enabled AND deleted_at IS NULL FOR UPDATE",
          [chatId],
        )
      ).rows[0];
      if (!chat)
        throw new ApplicationError(
          "MEMORY_CHAT_UNAVAILABLE",
          "Chat monitoring must be enabled.",
          409,
        );
      const old = (
        await db.query<{ version: number }>(
          "SELECT version FROM memory_chats WHERE chat_id=$1 FOR UPDATE",
          [chatId],
        )
      ).rows[0];
      if ((old?.version ?? 0) !== version)
        throw new ApplicationError(
          "MEMORY_VERSION_CONFLICT",
          "Refresh chat settings.",
          409,
        );
      await db.query(
        `INSERT INTO memory_chats(chat_id,enabled,from_index) VALUES($1,$2,$3) ON CONFLICT(chat_id) DO UPDATE SET enabled=$2,version=memory_chats.version+1`,
        [chatId, enabled, chat.next_message_index],
      );
    });
  }
  async scope(
    chatId: string,
    upperIndex: number,
    executionId: string | null,
  ): Promise<MemoryScope | null> {
    const row = (
      await this.pool.query<Generation>(
        `SELECT g.* FROM memory_generations g WHERE g.status='active'
      AND EXISTS(SELECT 1 FROM memory_settings WHERE enabled)
      AND EXISTS(SELECT 1 FROM memory_chats mc JOIN chats c ON c.id=mc.chat_id WHERE c.id=$1 AND mc.enabled AND c.enabled AND c.deleted_at IS NULL)`,
        [chatId],
      )
    ).rows[0];
    return row ? { chatId, upperIndex, executionId, generation: row } : null;
  }
  async scopeForEvent(
    provider: string,
    messageId: string,
    executionId: string,
    timeZone = "UTC",
  ): Promise<MemoryScope | null> {
    const row = (
      await this.pool.query<{ chat_id: string; message_index: string }>(
        "SELECT chat_id,message_index FROM messages WHERE provider=$1 AND provider_message_id=$2",
        [provider, messageId],
      )
    ).rows[0];
    const scope = row
      ? await this.scope(row.chat_id, Number(row.message_index), executionId)
      : null;
    return scope ? { ...scope, timeZone } : null;
  }
  async allowed(scope: MemoryScope): Promise<boolean> {
    return (
      (await this.scope(scope.chatId, scope.upperIndex, scope.executionId)) !==
      null
    );
  }
  async chatView(chatId: string) {
    const chat = (
      await this.pool.query<{ next_message_index: string }>(
        "SELECT next_message_index FROM chats WHERE id=$1 AND deleted_at IS NULL",
        [chatId],
      )
    ).rows[0];
    if (!chat)
      throw new ApplicationError("CHAT_NOT_FOUND", "Chat unavailable.", 404);
    const authorization = (
      await this.pool.query<{
        enabled: boolean;
        version: number;
        from_index: string;
      }>(
        "SELECT enabled,version,from_index FROM memory_chats WHERE chat_id=$1",
        [chatId],
      )
    ).rows[0] ?? { enabled: false, version: 0 };
    const generation = (
      await this.pool.query<Generation>(
        "SELECT * FROM memory_generations WHERE status='active'",
      )
    ).rows[0];
    const scope = generation
      ? {
          chatId,
          upperIndex: Number(chat.next_message_index),
          executionId: null,
          generation,
        }
      : null;
    return {
      ...authorization,
      upperIndex: Number(chat.next_message_index),
      coverage: scope ? await this.coverage(scope) : null,
    };
  }
  async coverage(scope: MemoryScope) {
    const row = (
      await this.pool.query<{ total: string; indexed: string; failed: string }>(
        `SELECT count(*) total,count(i.message_id) indexed,
        count(*) FILTER (WHERE i.message_id IS NULL AND EXISTS (
          SELECT 1 FROM memory_jobs j WHERE j.chat_id=m.chat_id AND j.generation_id=$2 AND j.status='failed'
          AND m.message_index BETWEEN j.from_index AND j.through_index
          AND (j.range_from IS NULL OR m.sent_at>=j.range_from) AND (j.range_to IS NULL OR m.sent_at<=j.range_to)
        )) failed FROM messages m
      LEFT JOIN memory_indexed_messages i ON i.message_id=m.id AND i.generation_id=$2
      WHERE m.chat_id=$1 AND m.message_index<$3 AND m.content_redacted_at IS NULL`,
        [scope.chatId, scope.generation.id, scope.upperIndex],
      )
    ).rows[0];
    const total = Number(row?.total ?? 0),
      indexed = Number(row?.indexed ?? 0);
    return {
      total,
      indexed,
      pending: total - indexed,
      failed: Number(row?.failed ?? 0),
    };
  }
  async messages(
    chatId: string,
    from: number,
    through: number,
    db: Pool | PoolClient = this.pool,
    lock = false,
  ): Promise<MemoryMessage[]> {
    const rows = await db.query<MessageRow>(
      `SELECT ${messageColumns} FROM messages m WHERE m.chat_id=$1 AND m.message_index BETWEEN $2 AND $3 AND m.content_redacted_at IS NULL ORDER BY m.message_index LIMIT 100 ${lock ? "FOR SHARE OF m" : ""}`,
      [chatId, from, through],
    );
    return rows.rows.map(memoryMessage);
  }
  async createJob(
    chatId: string,
    generationId: string,
    from: string | undefined,
    to: string | undefined,
    requestKey: string,
  ) {
    return this.transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        requestKey,
      ]);
      const existing = (
        await db.query<MemoryJob>(
          "SELECT * FROM memory_jobs WHERE request_key=$1",
          [requestKey],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.chat_id !== chatId ||
          existing.generation_id !== generationId ||
          (existing.range_from?.toISOString() ?? null) !==
            (from ? new Date(from).toISOString() : null) ||
          (existing.range_to?.toISOString() ?? null) !==
            (to ? new Date(to).toISOString() : null)
        )
          throw new ApplicationError(
            "MEMORY_REQUEST_CONFLICT",
            "Request key already used for another range.",
            409,
          );
        return { id: existing.id };
      }
      const allowed = await this.scope(chatId, Number.MAX_SAFE_INTEGER, null);
      if (!allowed)
        throw new ApplicationError(
          "MEMORY_DISABLED",
          "Enable chat memory before indexing.",
          409,
        );
      const generation = (
        await db.query(
          "SELECT 1 FROM memory_generations WHERE id=$1 AND status!='retired'",
          [generationId],
        )
      ).rowCount;
      if (!generation)
        throw new ApplicationError(
          "MEMORY_GENERATION_UNAVAILABLE",
          "Generation unavailable.",
          409,
        );
      const range = (
        await db.query<{ lo: string | null; hi: string | null }>(
          "SELECT min(message_index) lo,max(message_index) hi FROM messages WHERE chat_id=$1 AND content_redacted_at IS NULL AND ($2::timestamptz IS NULL OR sent_at >=$2) AND ($3::timestamptz IS NULL OR sent_at<=$3)",
          [chatId, from ?? null, to ?? null],
        )
      ).rows[0];
      if (!range?.lo || !range.hi)
        throw new ApplicationError(
          "MEMORY_EMPTY_RANGE",
          "No retained messages in this range.",
          409,
        );
      const result = await db.query<{ id: string }>(
        `INSERT INTO memory_jobs(chat_id,generation_id,reason,from_index,through_index,cursor_index,request_key,range_from,range_to) VALUES($1,$2,'backfill',$3,$4,$3::bigint-1,$5,$6,$7)
        ON CONFLICT(request_key) DO NOTHING RETURNING id`,
        [
          chatId,
          generationId,
          range.lo,
          range.hi,
          requestKey,
          from ?? null,
          to ?? null,
        ],
      );
      if (result.rows[0])
        await this.initializeProgress(db, result.rows[0].id, "full");
      return (
        result.rows[0] ??
        (
          await db.query<{ id: string }>(
            "SELECT id FROM memory_jobs WHERE request_key=$1 AND chat_id=$2",
            [requestKey, chatId],
          )
        ).rows[0]
      );
    });
  }
  private async initializeProgress(db: PoolClient, id: string, scope: string) {
    const job = (
      await db.query<MemoryJob>("SELECT * FROM memory_jobs WHERE id=$1", [id])
    ).rows[0]!;
    let cursor = Number(job.cursor_index);
    while (cursor < Number(job.through_index)) {
      const rows = await this.messages(
        job.chat_id,
        cursor + 1,
        Number(job.through_index),
        db,
      );
      if (!rows.length) break;
      const included = rows.filter(
        (m) =>
          (!job.range_from ||
            Date.parse(m.sentAt) >= job.range_from.getTime()) &&
          (!job.range_to || Date.parse(m.sentAt) <= job.range_to.getTime()),
      );
      if (included.length)
        await db.query(
          `INSERT INTO memory_job_items(job_id,message_id,message_index,characters)
        SELECT $1,x.id,x.idx,x.chars FROM unnest($2::uuid[],$3::bigint[],$4::int[]) AS x(id,idx,chars) ON CONFLICT DO NOTHING`,
          [
            id,
            included.map((m) => m.id),
            included.map((m) => m.index),
            included.map((m) => m.text.length),
          ],
        );
      cursor = rows.at(-1)!.index;
    }
    await db.query("UPDATE memory_jobs SET progress_scope=$2 WHERE id=$1", [
      id,
      scope,
    ]);
  }
  async jobs(
    chatId?: string,
    options?: {
      limit: number;
      cursor?: { timestamp: Date; id: string } | null;
      id?: string;
    },
  ) {
    const rows = (
      await this.pool.query<
        MemoryJob & {
          status: string;
          version: number;
          chat_name: string | null;
          model: string;
          reason: string;
          error_code: string | null;
          created_at: Date;
          updated_at: Date;
          current: boolean;
          total: number;
          processed: number;
          removed: number;
          remaining: number;
          characters: number;
        }
      >(
        `SELECT j.id,j.chat_id,j.generation_id,j.reason,j.from_index,j.through_index,j.cursor_index,j.status,j.request_key,j.attempts,j.error_code,j.version,j.created_at,j.updated_at,j.range_from,j.range_to,j.progress_scope,j.progress_samples,j.progress_started_at,j.progress_last_at,
      c.display_name AS chat_name,g.config->>'model' AS model,
      (j.progress_worker=$2 AND j.progress_started_at IS NOT NULL AND c.enabled AND c.deleted_at IS NULL AND EXISTS(SELECT 1 FROM memory_settings WHERE enabled) AND EXISTS(SELECT 1 FROM memory_chats mc WHERE mc.chat_id=j.chat_id AND mc.enabled) AND g.status!='retired' AND NOT EXISTS(SELECT 1 FROM memory_jobs other WHERE other.id<>j.id AND other.status='running' AND other.lease_until>now())) AS current,
      p.total,p.processed,p.removed,p.remaining,p.characters
      FROM (SELECT * FROM memory_jobs WHERE ($1::uuid IS NULL OR chat_id=$1) AND ($7::uuid IS NULL OR id=$7) AND ($3::timestamptz IS NULL OR (date_trunc('milliseconds',created_at),id)<($3,$4::uuid)) ORDER BY CASE WHEN $5 THEN 0 WHEN status='running' OR (status='queued' AND progress_worker=$2) THEN 0 WHEN status IN ('queued','paused') THEN 1 ELSE 2 END,date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $6) j JOIN chats c ON c.id=j.chat_id JOIN memory_generations g ON g.id=j.generation_id
      LEFT JOIN LATERAL (SELECT count(*)::int total,count(*) FILTER(WHERE state='processed')::int processed,
        count(*) FILTER(WHERE state='removed')::int removed,count(*) FILTER(WHERE state='pending')::int remaining,
        coalesce(sum(characters) FILTER(WHERE state='pending'),0)::float8 characters
        FROM memory_job_items WHERE job_id=j.id) p ON TRUE
      WHERE ($1::uuid IS NULL OR j.chat_id=$1) ORDER BY CASE WHEN $5 THEN 0 WHEN j.status='running' OR (j.status='queued' AND j.progress_worker=$2) THEN 0 WHEN j.status IN ('queued','paused') THEN 1 ELSE 2 END,date_trunc('milliseconds',j.created_at) DESC,j.id DESC LIMIT $6`,
        [
          chatId ?? null,
          this.workerId,
          options?.cursor?.timestamp ?? null,
          options?.cursor?.id ?? null,
          !!options,
          options?.limit ?? 100,
          options?.id ?? null,
        ],
      )
    ).rows;
    return rows.map(
      ({
        progress_samples,
        progress_started_at,
        progress_last_at,
        progress_scope,
        current,
        total,
        processed,
        removed,
        remaining,
        characters,
        ...job
      }) => ({
        ...job,
        progress: {
          scope: progress_scope,
          total,
          processed,
          removed,
          remaining,
          percent: progress_scope
            ? total
              ? ((processed + removed) / total) * 100
              : job.status === "succeeded"
                ? 100
                : 0
            : null,
          lastProgressAt: progress_last_at,
          generatedAt: new Date().toISOString(),
          estimate: estimateProgress(
            progress_samples,
            characters,
            job.status,
            progress_last_at?.getTime() ??
              progress_started_at?.getTime() ??
              null,
            current,
          ),
        },
      }),
    );
  }
  async action(id: string, action: string, version: number) {
    return this.transaction(async (db) => {
      const job = (
        await db.query<MemoryJob & { status: string; version: number }>(
          "SELECT * FROM memory_jobs WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!job)
        throw new ApplicationError(
          "MEMORY_JOB_NOT_FOUND",
          "Index job unavailable.",
          404,
        );
      if (job.version !== version)
        throw new ApplicationError(
          "MEMORY_VERSION_CONFLICT",
          "Refresh index job.",
          409,
        );
      if (action === "activate") {
        await db.query(
          "SELECT pg_advisory_xact_lock(hashtext('memory-settings'))",
        );
        const target = (
          await db.query<{ status: string }>(
            "SELECT status FROM memory_generations WHERE id=$1 FOR UPDATE",
            [job.generation_id],
          )
        ).rows[0];
        if (!target || target.status !== "building")
          throw new ApplicationError(
            "MEMORY_GENERATION_UNAVAILABLE",
            "Only a building generation can be activated.",
            409,
          );
        const gaps = await db.query(
          `SELECT 1 FROM messages m LEFT JOIN memory_indexed_messages i ON i.message_id=m.id AND i.generation_id=$2 WHERE m.chat_id=$1 AND m.message_index BETWEEN $3 AND $4 AND m.content_redacted_at IS NULL AND ($5::timestamptz IS NULL OR m.sent_at>=$5) AND ($6::timestamptz IS NULL OR m.sent_at<=$6) AND i.message_id IS NULL LIMIT 1`,
          [
            job.chat_id,
            job.generation_id,
            job.from_index,
            job.through_index,
            job.range_from,
            job.range_to,
          ],
        );
        const previousGaps = await db.query(
          `SELECT 1 FROM memory_indexed_messages old JOIN memory_generations g ON g.id=old.generation_id AND g.status='active' JOIN messages m ON m.id=old.message_id JOIN memory_chats mc ON mc.chat_id=m.chat_id AND mc.enabled WHERE m.content_redacted_at IS NULL AND NOT EXISTS(SELECT 1 FROM memory_indexed_messages target WHERE target.generation_id=$1 AND target.message_id=m.id) LIMIT 1`,
          [job.generation_id],
        );
        if (
          job.status !== "succeeded" ||
          gaps.rowCount ||
          previousGaps.rowCount
        )
          throw new ApplicationError(
            "MEMORY_COVERAGE_INCOMPLETE",
            "Complete and verify the selected index range first.",
            409,
          );
        await db.query(
          "UPDATE memory_generations SET status='retired' WHERE status='active' AND id<>$1",
          [job.generation_id],
        );
        await db.query(
          "UPDATE memory_generations SET status='active' WHERE id=$1",
          [job.generation_id],
        );
      } else {
        const next =
          action === "pause"
            ? "paused"
            : action === "cancel"
              ? "cancelled"
              : "queued";
        const valid =
          action === "pause"
            ? ["queued", "running"]
            : action === "cancel"
              ? ["queued", "running", "paused", "failed"]
              : ["paused", "failed"];
        if (!valid.includes(job.status))
          throw new ApplicationError(
            "MEMORY_JOB_STATE_CONFLICT",
            "Action is not valid for this job state.",
            409,
          );
        await db.query(
          "UPDATE memory_jobs SET status=$2,reason=CASE WHEN $2='queued' THEN 'backfill' ELSE reason END,version=version+1,lease_owner=NULL,lease_until=NULL,progress_worker=NULL,progress_samples='[]',progress_started_at=NULL,progress_last_at=NULL,attempts=0,next_attempt_at=now(),updated_at=now() WHERE id=$1",
          [id, next],
        );
      }
    });
  }
  async claim(): Promise<MemoryJob | null> {
    return this.transaction(async (db) => {
      await db.query(
        "UPDATE memory_jobs SET status='failed',error_code='MEMORY_RETRIES_EXHAUSTED',version=version+1 WHERE status='running' AND lease_until<now() AND attempts>=3",
      );
      const row = (
        await db.query<MemoryJob>(`SELECT j.* FROM memory_jobs j JOIN chats c ON c.id=j.chat_id JOIN memory_chats mc ON mc.chat_id=c.id JOIN memory_generations g ON g.id=j.generation_id
        WHERE c.enabled AND NOT c.bot_memory_rebuild_required AND j.bot_identity_revision=c.bot_identity_revision AND mc.enabled AND c.deleted_at IS NULL AND g.status!='retired' AND EXISTS(SELECT 1 FROM memory_settings WHERE enabled)
        AND NOT EXISTS(SELECT 1 FROM bot_attribution_jobs b JOIN messages bm ON bm.id=b.message_id WHERE b.status IN ('queued','running') AND bm.chat_id=c.id AND bm.message_index BETWEEN j.from_index AND j.through_index)
        AND (j.status='queued' OR (j.status='running' AND j.lease_until<now())) AND j.attempts<3 AND j.next_attempt_at<=now()
        ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`)
      ).rows[0];
      if (!row) return null;
      if (!row.progress_scope && row.request_key)
        await this.initializeProgress(db, row.id, "remaining");
      await db.query(
        `UPDATE memory_jobs SET progress_samples='[]',progress_started_at=NULL,progress_worker=NULL WHERE id<>$1 AND progress_worker IS NOT NULL`,
        [row.id],
      );
      await db.query(
        `UPDATE memory_jobs SET progress_samples=CASE WHEN progress_worker=$2 AND progress_last_at>now()-interval '60 seconds' THEN progress_samples ELSE '[]'::jsonb END,
        progress_last_at=CASE WHEN progress_worker=$2 AND progress_last_at>now()-interval '60 seconds' THEN progress_last_at ELSE NULL END,progress_started_at=CASE WHEN progress_worker=$2 AND progress_last_at>now()-interval '60 seconds' THEN progress_started_at ELSE now() END,progress_worker=$2 WHERE id=$1`,
        [row.id, this.workerId],
      );
      const owner = randomUUID();
      return (
        (
          await db.query<MemoryJob>(
            "UPDATE memory_jobs SET status='running',lease_owner=$2,lease_until=now()+interval '60 seconds',attempts=attempts+1,version=version+1 WHERE id=$1 RETURNING *",
            [row.id, owner],
          )
        ).rows[0] ?? null
      );
    });
  }
  async publish(
    job: MemoryJob,
    messages: MemoryMessage[],
    chunks: MemoryChunk[],
    vectors: number[][],
    scannedThrough?: number,
  ) {
    await this.transaction(async (db) => {
      await db.query("SELECT id FROM chats WHERE id=$1 FOR SHARE", [
        job.chat_id,
      ]);
      const row = await db.query(
        "SELECT 1 FROM memory_jobs WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_until>now() AND bot_identity_revision=(SELECT bot_identity_revision FROM chats WHERE id=memory_jobs.chat_id) AND NOT (SELECT bot_memory_rebuild_required FROM chats WHERE id=memory_jobs.chat_id) FOR UPDATE",
        [job.id, job.lease_owner],
      );
      if (!row.rowCount) return;
      const fresh = await this.messages(
        job.chat_id,
        Number(job.cursor_index) + 1,
        Number(job.through_index),
        db,
        true,
      );
      if (
        messages.some((m) => fresh.find((f) => f.id === m.id)?.hash !== m.hash)
      )
        throw new Error("MEMORY_SOURCE_CHANGED");
      const generation = (
        await db.query<Generation>(
          "SELECT * FROM memory_generations WHERE id=$1 AND status!='retired' FOR SHARE",
          [job.generation_id],
        )
      ).rows[0];
      if (!generation) throw new Error("MEMORY_GENERATION_UNAVAILABLE");
      const authorization = await db.query(
        "SELECT 1 FROM memory_chats mc JOIN chats c ON c.id=mc.chat_id WHERE c.id=$1 AND mc.enabled AND c.enabled AND c.deleted_at IS NULL AND EXISTS(SELECT 1 FROM memory_settings WHERE enabled) FOR SHARE OF mc,c",
        [job.chat_id],
      );
      if (!authorization.rowCount) throw new Error("MEMORY_DISABLED");
      for (let n = 0; n < chunks.length; n++) {
        const chunk = chunks[n];
        const vector = vectors[n];
        if (!chunk || !vector)
          throw new Error("MEMORY_EMBEDDING_INVALID_OUTPUT");
        const id = randomUUID();
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO memory_chunks(id,chat_id,generation_id,from_index,through_index,text,keywords,content_hash) VALUES($1,$2,$3,$4,$5,$6,to_tsvector('simple',$7),$8)
          ON CONFLICT(generation_id,chat_id,from_index,through_index,content_hash) DO UPDATE SET valid=TRUE,text=EXCLUDED.text,keywords=EXCLUDED.keywords RETURNING id`,
          [
            id,
            job.chat_id,
            job.generation_id,
            chunk.from,
            chunk.through,
            chunk.text,
            keywordTokens(chunk.text).join(" "),
            contentHash(chunk.text),
          ],
        );
        const chunkId = inserted.rows[0]?.id as string;
        for (const source of chunk.sources)
          await db.query(
            "INSERT INTO memory_chunk_sources VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            [chunkId, source.messageId, source.hash, source.start, source.end],
          );
        await db.query(
          "INSERT INTO memory_embeddings VALUES($1,$2,$3::vector) ON CONFLICT(chunk_id) DO UPDATE SET embedding=EXCLUDED.embedding,dimensions=EXCLUDED.dimensions",
          [chunkId, generation.config.dimensions, JSON.stringify(vector)],
        );
      }
      for (const m of messages)
        await db.query(
          "INSERT INTO memory_indexed_messages VALUES($1,$2) ON CONFLICT DO NOTHING",
          [job.generation_id, m.id],
        );
      const cursor =
        scannedThrough ?? messages.at(-1)?.index ?? Number(job.through_index);
      await db.query(
        `UPDATE memory_job_items i SET state='removed' WHERE job_id=$1 AND state='pending' AND message_index<=$2 AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=i.message_id AND m.content_redacted_at IS NULL)`,
        [job.id, cursor],
      );
      const completed = await db.query<{ characters: number }>(
        `UPDATE memory_job_items SET state='processed' WHERE job_id=$1 AND state='pending' AND message_id=ANY($2::uuid[]) RETURNING characters`,
        [job.id, messages.map((m) => m.id)],
      );
      const timing = (
        await db.query<MemoryJob>("SELECT * FROM memory_jobs WHERE id=$1", [
          job.id,
        ])
      ).rows[0]!;
      const now = Date.now();
      const sample: ProgressSample = {
        at: now,
        milliseconds: Math.max(
          1,
          now -
            (
              timing.progress_last_at ??
              timing.progress_started_at ??
              new Date(now)
            ).getTime(),
        ),
        characters: messages.reduce((n, m) => n + m.text.length, 0),
        messages: completed.rowCount ?? 0,
      };
      const samples = [...timing.progress_samples, sample].slice(-10);
      await db.query(
        "UPDATE memory_jobs SET progress_samples=$2::jsonb,progress_last_at=now() WHERE id=$1",
        [job.id, JSON.stringify(samples)],
      );
      await db.query(
        `UPDATE memory_jobs SET cursor_index=$2,status=CASE WHEN $2>=through_index THEN 'succeeded' ELSE 'queued' END,
        reason=CASE WHEN $2<through_index THEN 'backfill' ELSE reason END,attempts=0,lease_owner=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE id=$1`,
        [job.id, cursor],
      );
    });
  }
  async fail(job: MemoryJob, code: string) {
    await this.pool.query(
      "UPDATE memory_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,reason='backfill',error_code=$3,progress_worker=NULL,progress_samples='[]',progress_started_at=NULL,progress_last_at=NULL,lease_owner=NULL,lease_until=NULL,next_attempt_at=now()+interval '10 seconds'*attempts,version=version+1 WHERE id=$1 AND lease_owner=$2 AND status='running'",
      [job.id, job.lease_owner, code],
    );
  }
  async excerpt(scope: MemoryScope, chunkId: string): Promise<MemoryMessage[]> {
    const rows = await this.pool.query<{
      message_index: string;
      source_hash: string;
      start_offset: number;
      end_offset: number;
    }>(
      `SELECT m.message_index,s.source_hash,s.start_offset,s.end_offset FROM memory_chunks c JOIN memory_chunk_sources s ON s.chunk_id=c.id JOIN messages m ON m.id=s.message_id WHERE c.id=$1 AND c.chat_id=$2 AND c.generation_id=$3 AND c.valid AND c.bot_identity_revision=(SELECT bot_identity_revision FROM chats WHERE id=c.chat_id) AND NOT (SELECT bot_memory_rebuild_required FROM chats WHERE id=c.chat_id) AND c.through_index<$4 AND m.content_redacted_at IS NULL ORDER BY m.message_index,s.start_offset`,
      [chunkId, scope.chatId, scope.generation.id, scope.upperIndex],
    );
    const result: MemoryMessage[] = [];
    for (const row of rows.rows) {
      const message = (
        await this.messages(
          scope.chatId,
          Number(row.message_index),
          Number(row.message_index),
        )
      )[0];
      if (!message || message.hash !== row.source_hash) return [];
      result.push({
        ...message,
        text: message.text.slice(row.start_offset, row.end_offset),
        excerptStart: row.start_offset,
        excerptEnd: row.end_offset,
      });
    }
    return result;
  }
  async generation(id: string): Promise<Generation | null> {
    return (
      (
        await this.pool.query<Generation>(
          "SELECT * FROM memory_generations WHERE id=$1",
          [id],
        )
      ).rows[0] ?? null
    );
  }
  async unindexed(
    scope: MemoryScope,
    query: MemorySearch,
  ): Promise<MemoryMessage[]> {
    const rows = await this.pool.query<MessageRow>(
      `SELECT ${messageColumns} FROM messages m
      WHERE m.chat_id=$1 AND m.message_index<$2 AND m.content_redacted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM memory_indexed_messages i WHERE i.message_id=m.id AND i.generation_id=$3)
      AND ($4::timestamptz IS NULL OR m.sent_at >= $4) AND ($5::timestamptz IS NULL OR m.sent_at <= $5)
      AND ($6::text IS NULL OR m.sender_id=$6) AND ($7::uuid IS NULL OR EXISTS(SELECT 1 FROM message_bot_attributions a WHERE a.message_id=m.id AND a.workflow_id=$7)) ORDER BY m.message_index DESC LIMIT 100`,
      [
        scope.chatId,
        scope.upperIndex,
        scope.generation.id,
        query.from ?? null,
        query.to ?? null,
        query.senderId ?? null,
        query.botWorkflowId ?? null,
      ],
    );
    const tokens = keywordTokens(query.query);
    return rows.rows
      .map(memoryMessage)
      .filter((m) => tokens.some((t) => m.text.toLowerCase().includes(t)))
      .slice(0, 5);
  }
  async identities(chatId: string, senderIds: string[]) {
    return (
      await this.pool.query<{
        sender_id: string;
        real_name: string | null;
        nickname: string | null;
      }>(
        "SELECT sender_id,real_name,nickname FROM chat_participant_identities WHERE chat_id=$1 AND sender_id=ANY($2::text[])",
        [chatId, senderIds],
      )
    ).rows;
  }
  async latest(
    scope: MemoryScope,
    query: LatestChatMessages,
  ): Promise<MemoryMessage[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT ${messageColumns} FROM messages m
       WHERE m.chat_id=$1 AND m.message_index<$2 AND m.content_redacted_at IS NULL
       AND ($3::text IS NULL OR m.sender_id=$3)
       AND ($4::timestamptz IS NULL OR m.sent_at >= $4)
       AND ($5::timestamptz IS NULL OR m.sent_at <= $5)
       ORDER BY m.sent_at DESC,m.message_index DESC LIMIT $6`,
      [
        scope.chatId,
        scope.upperIndex,
        query.senderId ?? null,
        query.from ?? null,
        query.to ?? null,
        query.limit,
      ],
    );
    return result.rows.map(memoryMessage);
  }
  async candidates(
    scope: MemoryScope,
    query: MemorySearch,
    vector: number[] | null,
  ): Promise<Candidate[]> {
    const tokens = keywordTokens(query.query).slice(0, 40);
    if (!vector && !tokens.length) return [];
    const filter = `c.chat_id=$1 AND c.generation_id=$2 AND c.through_index<$3 AND c.valid AND c.bot_identity_revision=(SELECT bot_identity_revision FROM chats WHERE id=c.chat_id) AND NOT (SELECT bot_memory_rebuild_required FROM chats WHERE id=c.chat_id)
      AND NOT EXISTS(SELECT 1 FROM memory_chunk_sources s JOIN messages m ON m.id=s.message_id WHERE s.chunk_id=c.id AND (m.content_redacted_at IS NOT NULL OR ($4::timestamptz IS NOT NULL AND m.sent_at<$4) OR ($5::timestamptz IS NOT NULL AND m.sent_at>$5)))
      AND ($6::text IS NULL OR EXISTS(SELECT 1 FROM memory_chunk_sources s JOIN messages m ON m.id=s.message_id WHERE s.chunk_id=c.id AND m.sender_id=$6)) AND ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM memory_chunk_sources s JOIN message_bot_attributions a ON a.message_id=s.message_id WHERE s.chunk_id=c.id AND a.workflow_id=$8))`;
    return (
      await this.pool.query<Candidate>(
        vector
          ? `SELECT c.id,c.from_index,c.through_index FROM memory_chunks c JOIN memory_embeddings e ON e.chunk_id=c.id WHERE ${filter} ORDER BY e.embedding <=> $7::vector LIMIT 20`
          : `SELECT c.id,c.from_index,c.through_index FROM memory_chunks c WHERE ${filter} AND c.keywords @@ to_tsquery('simple',$7) ORDER BY ts_rank(c.keywords,to_tsquery('simple',$7)) DESC,c.id LIMIT 20`,
        [
          scope.chatId,
          scope.generation.id,
          scope.upperIndex,
          query.from ?? null,
          query.to ?? null,
          query.senderId ?? null,
          vector
            ? JSON.stringify(vector)
            : tokens.map((t) => `'${t.replaceAll("'", "''")}'`).join(" | "),
          query.botWorkflowId ?? null,
        ],
      )
    ).rows;
  }
}
