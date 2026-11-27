import { chatDisplayNameSql } from "../archive/chat-display-name-sql.js";
import { executionPolicy } from "../ai/execution-policy.js";
import {
  memoryMessage,
  messageColumns,
  scopedMessageColumns,
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
  defaultEmbeddingTimeoutSeconds,
  defaultGenerationRetentionDays,
  type Generation,
  type MemoryScope,
  type MemorySearch,
} from "./memory-types.js";
import {
  isUpstreamFailure,
  type EmbeddingConfig,
  type EmbeddingFailureDetail,
} from "./embedding-client.js";
import { estimateProgress, type ProgressSample } from "./job-progress.js";
import { vectorIndexSql, vectorLayout } from "./vector-storage.js";
export interface MemoryJob {
  reason: string;
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
        request_timeout_seconds: number;
        generation_retention_days: number;
      }>("SELECT * FROM memory_settings WHERE id=1")
    ).rows[0];
    return (
      row ?? {
        config: defaultMemoryConfig,
        enabled: false,
        version: 0,
        encrypted_secret: null,
        request_timeout_seconds: defaultEmbeddingTimeoutSeconds,
        generation_retention_days: defaultGenerationRetentionDays,
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
    timeoutSeconds?: number,
    retentionDays?: number,
  ): Promise<{ switched: boolean; generationId: string }> {
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
      // The same model (config + identity) reuses its generation; a retired
      // one inside the retention period is restored instead of rebuilt.
      const match = (
        await db.query<Generation>(
          "SELECT * FROM memory_generations WHERE config=$1::jsonb AND identity=$2 AND status IN ('active','retired','building') ORDER BY (status='active') DESC,created_at DESC LIMIT 1 FOR UPDATE",
          [JSON.stringify(config), identity],
        )
      ).rows[0];
      let generationId: string;
      const switched = match?.status !== "active";
      if (!switched) {
        generationId = match.id;
        await db.query(
          "UPDATE memory_generations SET encrypted_secret=$2 WHERE id=$1",
          [generationId, encrypted],
        );
      } else {
        // A model change takes effect at once: the new generation serves
        // (and indexes) from now on and is filled from zero in the background.
        await db.query(
          "UPDATE memory_generations SET status='retired',retired_at=now() WHERE status IN ('active','building') AND id IS DISTINCT FROM $1",
          [match?.id ?? null],
        );
        if (match) {
          generationId = match.id;
          await db.query(
            "UPDATE memory_generations SET status='active',retired_at=NULL,encrypted_secret=$2 WHERE id=$1",
            [generationId, encrypted],
          );
        } else {
          generationId = randomUUID();
          await db.query(
            "INSERT INTO memory_generations(id,config,encrypted_secret,identity,status) VALUES($1,$2,$3,$4,'active')",
            [generationId, config, encrypted, identity],
          );
        }
        // Work for replaced generations stops; their rows stay until purged.
        await db.query(
          "UPDATE memory_jobs SET status='superseded',lease_owner=NULL,lease_until=NULL,progress_worker=NULL,version=version+1,updated_at=now() WHERE generation_id<>$1 AND status IN ('queued','running','paused')",
          [generationId],
        );
        await this.ensureVectorIndex(db, config);
        await this.enqueueBackfill(db, generationId);
      }
      await db.query(
        `INSERT INTO memory_settings(id,enabled,config,encrypted_secret,version,request_timeout_seconds,generation_retention_days)
        VALUES(1,$1,$2,$3,1,COALESCE($4::int,${defaultEmbeddingTimeoutSeconds}),COALESCE($5::int,${defaultGenerationRetentionDays}))
        ON CONFLICT(id) DO UPDATE SET enabled=$1,config=$2,encrypted_secret=$3,version=memory_settings.version+1,
        request_timeout_seconds=COALESCE($4::int,memory_settings.request_timeout_seconds),
        generation_retention_days=COALESCE($5::int,memory_settings.generation_retention_days)`,
        [
          enabled,
          config,
          encrypted,
          timeoutSeconds ?? null,
          retentionDays ?? null,
        ],
      );
      return { switched, generationId };
    });
  }
  /** HNSW index for a generation's dimension and precision (idempotent). */
  async ensureVectorIndex(
    db: Pool | PoolClient,
    config: Pick<EmbeddingConfig, "dimensions" | "precision">,
  ) {
    const sql = vectorIndexSql(vectorLayout(config));
    if (sql) await db.query(sql);
  }
  /** Creates the active generation's index if an upgrade left it missing. */
  async ensureActiveVectorIndex() {
    if (!(await this.ready())) return;
    const active = (
      await this.pool.query<Generation>(
        "SELECT * FROM memory_generations WHERE status='active'",
      )
    ).rows[0];
    if (active) await this.ensureVectorIndex(this.pool, active.config);
  }
  /**
   * Gap-only full backfill for every enabled chat (or one chat). Reuses an
   * unfinished full backfill instead of stacking duplicates; job items and
   * progress are initialised when the worker claims the job.
   */
  async enqueueBackfill(
    db: Pool | PoolClient,
    generationId: string,
    chatId?: string,
  ): Promise<string[]> {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO memory_jobs(chat_id,generation_id,reason,from_index,through_index,cursor_index)
      SELECT c.id,$1,'backfill',1,c.next_message_index-1,0 FROM memory_chats mc JOIN chats c ON c.id=mc.chat_id
      WHERE mc.enabled AND c.enabled AND c.deleted_at IS NULL AND c.next_message_index>1 AND ($2::uuid IS NULL OR c.id=$2)
      AND NOT EXISTS(SELECT 1 FROM memory_jobs j WHERE j.chat_id=c.id AND j.generation_id=$1 AND j.reason<>'incremental'
        AND j.status IN ('queued','running') AND j.range_from IS NULL AND j.range_to IS NULL)
      RETURNING id`,
      [generationId, chatId ?? null],
    );
    return rows.rows.map((r) => r.id);
  }
  async authorize(
    chatId: string,
    enabled: boolean,
    version: number,
  ): Promise<string[]> {
    return this.transaction(async (db) => {
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
      // Enabling covers the whole history, so edits to any message re-index.
      await db.query(
        `INSERT INTO memory_chats(chat_id,enabled,from_index) VALUES($1,$2,$3) ON CONFLICT(chat_id) DO UPDATE SET enabled=$2,version=memory_chats.version+1,
        from_index=CASE WHEN $2 THEN 0 ELSE memory_chats.from_index END`,
        [chatId, enabled, enabled ? 0 : chat.next_message_index],
      );
      if (!enabled) return [];
      // Enabling backfills all history (gap-only: a re-enabled chat reuses
      // its vectors and only fills what arrived while it was disabled).
      const active = (
        await db.query<{ id: string }>(
          "SELECT id FROM memory_generations WHERE status='active'",
        )
      ).rows[0];
      return active ? this.enqueueBackfill(db, active.id, chatId) : [];
    });
  }
  /**
   * Long-term retrieval health of every chat with memory settings, in one
   * pass (doc/迭代需求-长期检索易用性整改.md R8). "missing" counts retained,
   * unindexed messages that no queued or running job covers.
   */
  async health(chatId?: string): Promise<MemoryHealthView> {
    const settings = (
      await this.pool.query<{ enabled: boolean }>(
        "SELECT enabled FROM memory_settings WHERE id=1",
      )
    ).rows[0];
    const ready = await this.ready();
    const generation = (
      await this.pool.query<Generation>(
        "SELECT * FROM memory_generations WHERE status='active'",
      )
    ).rows[0];
    const rows = (
      await this.pool.query<HealthRow>(
        `WITH mc AS (SELECT mc.chat_id,mc.enabled,c.bot_memory_rebuild_required AS rebuild FROM memory_chats mc JOIN chats c ON c.id=mc.chat_id
          WHERE c.deleted_at IS NULL AND ($2::uuid IS NULL OR mc.chat_id=$2)),
        busy AS MATERIALIZED (SELECT chat_id,from_index,through_index FROM memory_jobs
          WHERE generation_id=$1 AND status IN ('queued','running') AND chat_id IN (SELECT chat_id FROM mc WHERE enabled)),
        counts AS (SELECT m.chat_id,count(*) total,count(i.message_id) indexed,
          count(*) FILTER (WHERE i.message_id IS NULL AND NOT EXISTS(SELECT 1 FROM busy b WHERE b.chat_id=m.chat_id AND m.message_index BETWEEN b.from_index AND b.through_index)) missing
          FROM messages m LEFT JOIN memory_indexed_messages i ON i.message_id=m.id AND i.generation_id=$1
          WHERE m.chat_id IN (SELECT chat_id FROM mc WHERE enabled) AND m.content_redacted_at IS NULL GROUP BY m.chat_id),
        jobs AS (SELECT chat_id,
          count(*) FILTER (WHERE reason<>'incremental' AND status IN ('queued','running') AND auto_retries=0) active,
          min(next_attempt_at) FILTER (WHERE status='queued' AND auto_retries>0) retry_at
          FROM memory_jobs WHERE generation_id=$1 AND status IN ('queued','running') GROUP BY chat_id),
        progress AS (SELECT j.chat_id,count(*) total,count(*) FILTER (WHERE i.state<>'pending') done
          FROM memory_jobs j JOIN memory_job_items i ON i.job_id=j.id
          WHERE j.generation_id=$1 AND j.reason<>'incremental' AND j.status IN ('queued','running') GROUP BY j.chat_id),
        errors AS (SELECT DISTINCT ON (chat_id) chat_id,error_code,error_detail,updated_at FROM memory_jobs
          WHERE generation_id=$1 AND error_code IS NOT NULL AND status IN ('queued','failed') ORDER BY chat_id,updated_at DESC)
        SELECT mc.chat_id,mc.enabled,mc.rebuild,coalesce(n.total,0)::int total,coalesce(n.indexed,0)::int indexed,coalesce(n.missing,0)::int missing,
          coalesce(j.active,0)::int active_jobs,j.retry_at,coalesce(p.total,0)::int progress_total,coalesce(p.done,0)::int progress_done,
          e.error_code,e.error_detail,e.updated_at AS error_at
        FROM mc LEFT JOIN counts n ON n.chat_id=mc.chat_id LEFT JOIN jobs j ON j.chat_id=mc.chat_id
        LEFT JOIN progress p ON p.chat_id=mc.chat_id LEFT JOIN errors e ON e.chat_id=mc.chat_id`,
        [generation?.id ?? null, chatId ?? null],
      )
    ).rows;
    const globalEnabled = !!settings?.enabled && ready && !!generation;
    return {
      globalEnabled,
      generation: generation
        ? {
            id: generation.id,
            model: generation.config.model,
            dimensions: generation.config.dimensions,
            precision: vectorLayout(generation.config).precision,
          }
        : null,
      chats: rows.map((r) => chatHealth(r, globalEnabled)),
    };
  }
  /**
   * Prepares a one-click repair: jobs waiting on an upstream retry run now,
   * failed and paused work is replaced by one gap-only backfill. Returns
   * "rebuild" when the chat needs an attribution rebuild instead.
   */
  async repair(
    chatId: string,
  ): Promise<{ action: "backfill" | "rebuild"; jobIds: string[] }> {
    return this.transaction(async (db) => {
      const row = (
        await db.query<{ rebuild: boolean; generation_id: string }>(
          `SELECT c.bot_memory_rebuild_required AS rebuild,g.id AS generation_id FROM chats c
          JOIN memory_chats mc ON mc.chat_id=c.id AND mc.enabled JOIN memory_generations g ON g.status='active'
          WHERE c.id=$1 AND c.enabled AND c.deleted_at IS NULL AND EXISTS(SELECT 1 FROM memory_settings WHERE enabled) FOR UPDATE OF c`,
          [chatId],
        )
      ).rows[0];
      if (!row)
        throw new ApplicationError(
          "MEMORY_DISABLED",
          "Enable long-term retrieval for this chat first.",
          409,
        );
      if (row.rebuild) return { action: "rebuild" as const, jobIds: [] };
      await db.query(
        "UPDATE memory_jobs SET next_attempt_at=now(),attempts=0,version=version+1,updated_at=now() WHERE chat_id=$1 AND generation_id=$2 AND status='queued' AND auto_retries>0",
        [chatId, row.generation_id],
      );
      await db.query(
        "UPDATE memory_jobs SET status='superseded',lease_owner=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE chat_id=$1 AND generation_id=$2 AND status IN ('failed','paused')",
        [chatId, row.generation_id],
      );
      const created = await this.enqueueBackfill(db, row.generation_id, chatId);
      if (created.length)
        return { action: "backfill" as const, jobIds: created };
      const existing = await db.query<{ id: string }>(
        "SELECT id FROM memory_jobs WHERE chat_id=$1 AND generation_id=$2 AND reason<>'incremental' AND status IN ('queued','running') ORDER BY created_at",
        [chatId, row.generation_id],
      );
      return {
        action: "backfill" as const,
        jobIds: existing.rows.map((r) => r.id),
      };
    });
  }
  /**
   * Deletes the vectors, chunks, indexed markers and jobs of replaced
   * generations; `all` ignores the retention period (manual purge). The
   * generation row stays as 'purged' so retrieval history keeps its
   * reference. Indexes no remaining generation needs are dropped.
   */
  async purgeRetired(all: boolean) {
    const targets = await this.transaction(async (db) => {
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtext('memory-settings'))",
      );
      return (
        await db.query<{ id: string }>(
          `UPDATE memory_generations SET status='purged' WHERE status IN ('retired','building')
          AND ($1 OR COALESCE(retired_at,created_at) < now() - make_interval(days =>
            COALESCE((SELECT generation_retention_days FROM memory_settings WHERE id=1),${defaultGenerationRetentionDays})))
          RETURNING id`,
          [all],
        )
      ).rows.map((r) => r.id);
    });
    let chunks = 0;
    const ids = await this.pool.query<{ id: string }>(
      "SELECT id FROM memory_generations WHERE status='purged'",
    );
    // Earlier interrupted purges are finished as well.
    const purged = ids.rows.map((r) => r.id);
    if (purged.length) {
      await this.pool.query(
        "DELETE FROM memory_jobs WHERE generation_id=ANY($1::uuid[])",
        [purged],
      );
      for (;;) {
        const r = await this.pool.query(
          `DELETE FROM memory_indexed_messages WHERE (generation_id,message_id) IN (
            SELECT generation_id,message_id FROM memory_indexed_messages WHERE generation_id=ANY($1::uuid[]) LIMIT 20000)`,
          [purged],
        );
        if (!r.rowCount) break;
      }
      for (;;) {
        // Vectors and sources cascade with their chunk.
        const r = await this.pool.query(
          `DELETE FROM memory_chunks WHERE id IN (
            SELECT id FROM memory_chunks WHERE generation_id=ANY($1::uuid[]) LIMIT 5000)`,
          [purged],
        );
        if (!r.rowCount) break;
        chunks += r.rowCount;
      }
    }
    if ((await this.ready()) && (targets.length || chunks))
      await this.dropUnusedVectorIndexes();
    return { generations: targets.length, chunks };
  }
  private async dropUnusedVectorIndexes() {
    const needed = new Set(
      (
        await this.pool.query<Generation>(
          "SELECT * FROM memory_generations WHERE status<>'purged'",
        )
      ).rows.map((g) => vectorLayout(g.config).indexName),
    );
    const indexes = await this.pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename='memory_embeddings' AND indexname LIKE 'memory\\_embeddings\\_hnsw\\_%'",
    );
    for (const { indexname } of indexes.rows)
      if (
        !needed.has(indexname) &&
        /^memory_embeddings_hnsw_f(16|32)_[0-9]+$/u.test(indexname)
      )
        await this.pool.query(`DROP INDEX IF EXISTS ${indexname}`);
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
  async scopeForIdle(
    executionId: string,
    timeZone = "UTC",
  ): Promise<MemoryScope | null> {
    const row = (
      await this.pool.query<{ chat_id: string; upper_index: string }>(
        `SELECT target_chat_id AS chat_id,COALESCE(trigger_event->'idle'->>'upperMessageIndex',trigger_event->'scheduled'->>'upperMessageIndex') AS upper_index
       FROM workflow_executions WHERE id=$1 AND trigger_event->>'schemaVersion' IN ('chat-idle-v1','scheduled-task-v1','scheduled-task-v2')`,
        [executionId],
      )
    ).rows[0];
    const scope = row
      ? await this.scope(row.chat_id, Number(row.upper_index), executionId)
      : null;
    return scope ? { ...scope, timeZone } : null;
  }

  async scopeForEvent(
    provider: string,
    messageId: string,
    executionId: string,
    timeZone = "UTC",
  ): Promise<MemoryScope | null> {
    const boundary = (
      await this.pool.query<{ boundary: { upperIndex?: string } | null }>(
        "SELECT freeze_execution_history($1) AS boundary",
        [executionId],
      )
    ).rows[0]?.boundary;
    const row = (
      await this.pool.query<{ chat_id: string; message_index: string }>(
        "SELECT chat_id,message_index FROM messages WHERE provider=$1 AND provider_message_id=$2",
        [provider, messageId],
      )
    ).rows[0];
    const scope = row
      ? await this.scope(
          row.chat_id,
          Number(boundary?.upperIndex ?? row.message_index),
          executionId,
        )
      : null;
    return scope
      ? { ...scope, timeZone, sentTimeBoundary: !!boundary?.upperIndex }
      : null;
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
        // Failed ranges are collected once per chat (not a job-table scan per
        // unindexed message), and the execution boundary check only runs
        // when there is a boundary: large chats stay well under the timeout.
        `WITH failed AS MATERIALIZED (
          SELECT from_index,through_index,range_from,range_to FROM memory_jobs
          WHERE chat_id=$1 AND generation_id=$2 AND status='failed')
        SELECT count(*) total,count(i.message_id) indexed,
        count(*) FILTER (WHERE i.message_id IS NULL AND EXISTS (
          SELECT 1 FROM failed j WHERE m.message_index BETWEEN j.from_index AND j.through_index
          AND (j.range_from IS NULL OR m.sent_at>=j.range_from) AND (j.range_to IS NULL OR m.sent_at<=j.range_to)
        )) failed FROM messages m
      LEFT JOIN memory_indexed_messages i ON i.message_id=m.id AND i.generation_id=$2
      WHERE m.chat_id=$1 AND m.message_index<$3 AND m.content_redacted_at IS NULL
      AND ($4::uuid IS NULL OR execution_history_allows($4,m.id))`,
        [
          scope.chatId,
          scope.generation.id,
          scope.upperIndex,
          scope.sentTimeBoundary ? scope.executionId : null,
        ],
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
  async surrounding(
    scope: MemoryScope,
    first: number,
    last: number,
    before: number,
    after: number,
  ) {
    // Count readable rows, not index offsets: gaps and redacted rows do not consume a slot.
    const read = async (direction: "before" | "after", count: number) => {
      const rows = await this.pool.query<MessageRow>(
        `SELECT ${scopedMessageColumns("$5", "$2")} FROM messages m WHERE m.chat_id=$1
         AND m.message_index<$2 AND m.content_redacted_at IS NULL AND execution_history_allows($5,m.id)
         AND m.message_index ${direction === "before" ? "<" : ">"} $3
         ORDER BY m.message_index ${direction === "before" ? "DESC" : "ASC"} LIMIT $4`,
        [
          scope.chatId,
          scope.upperIndex,
          direction === "before" ? first : last,
          count + 1,
          scope.sentTimeBoundary ? scope.executionId : null,
        ],
      );
      return rows.rows.map(memoryMessage);
    };
    const earlier = await read("before", before);
    const later = await read("after", after);
    return {
      before: earlier.slice(0, before).reverse(),
      after: later.slice(0, after),
      hasEarlier: earlier.length > before,
      hasLater: later.length > after,
    };
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
          "SELECT 1 FROM memory_generations WHERE id=$1 AND status='active'",
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
  /**
   * Job items are the messages this job still has to embed: retained,
   * in range and not yet indexed in the job's generation. Already indexed
   * history is never listed, so progress is measured against the real gap.
   */
  private async initializeProgress(db: PoolClient, id: string, scope: string) {
    await db.query(
      `INSERT INTO memory_job_items(job_id,message_id,message_index,characters)
      SELECT j.id,m.id,m.message_index,length(coalesce(m.body,'')) FROM memory_jobs j
      JOIN messages m ON m.chat_id=j.chat_id AND m.message_index>j.cursor_index AND m.message_index<=j.through_index
      WHERE j.id=$1 AND m.content_redacted_at IS NULL
        AND (j.range_from IS NULL OR m.sent_at>=j.range_from) AND (j.range_to IS NULL OR m.sent_at<=j.range_to)
        AND NOT EXISTS(SELECT 1 FROM memory_indexed_messages i WHERE i.message_id=m.id AND i.generation_id=j.generation_id)
      ON CONFLICT DO NOTHING`,
      [id],
    );
    await db.query("UPDATE memory_jobs SET progress_scope=$2 WHERE id=$1", [
      id,
      scope,
    ]);
  }
  /**
   * First message the job still has to index at or after its cursor, so a
   * backfill jumps over indexed history instead of reading it batch by batch.
   * Null when the remaining range is already complete.
   */
  async nextUnindexed(job: MemoryJob): Promise<number | null> {
    const row = (
      await this.pool.query<{ next: string | null }>(
        `SELECT min(m.message_index) AS next FROM messages m
        WHERE m.chat_id=$1 AND m.message_index>$2 AND m.message_index<=$3 AND m.content_redacted_at IS NULL
          AND ($5::timestamptz IS NULL OR m.sent_at>=$5) AND ($6::timestamptz IS NULL OR m.sent_at<=$6)
          AND NOT EXISTS(SELECT 1 FROM memory_indexed_messages i WHERE i.message_id=m.id AND i.generation_id=$4)`,
        [
          job.chat_id,
          job.cursor_index,
          job.through_index,
          job.generation_id,
          job.range_from,
          job.range_to,
        ],
      )
    ).rows[0];
    return row?.next ? Number(row.next) : null;
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
          error_detail: Record<string, unknown> | null;
          auto_retries: number;
          next_attempt_at: Date;
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
        `SELECT j.id,j.chat_id,j.generation_id,j.reason,j.from_index,j.through_index,j.cursor_index,j.status,j.request_key,j.attempts,j.error_code,j.error_detail,j.version,j.created_at,j.updated_at,j.range_from,j.range_to,j.progress_scope,j.progress_samples,j.progress_started_at,j.progress_last_at,j.auto_retries,j.next_attempt_at,
      ${chatDisplayNameSql("c")} AS chat_name,g.config->>'model' AS model,
      (j.progress_worker=$2 AND j.progress_started_at IS NOT NULL AND c.enabled AND c.deleted_at IS NULL AND EXISTS(SELECT 1 FROM memory_settings WHERE enabled) AND EXISTS(SELECT 1 FROM memory_chats mc WHERE mc.chat_id=j.chat_id AND mc.enabled) AND g.status='active' AND NOT EXISTS(SELECT 1 FROM memory_jobs other WHERE other.id<>j.id AND other.reason<>'incremental' AND other.status='running' AND other.lease_until>now())) AS current,
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
          "UPDATE memory_jobs SET status=$2,reason=CASE WHEN $2='queued' AND reason!='rebuild' THEN 'backfill' ELSE reason END,version=version+1,lease_owner=NULL,lease_until=NULL,progress_worker=NULL,progress_samples='[]',progress_started_at=NULL,progress_last_at=NULL,attempts=0,next_attempt_at=now(),updated_at=now() WHERE id=$1",
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
        WHERE c.enabled AND NOT c.bot_memory_rebuild_required AND j.bot_identity_revision=c.bot_identity_revision AND mc.enabled AND c.deleted_at IS NULL AND g.status='active' AND EXISTS(SELECT 1 FROM memory_settings WHERE enabled)
        AND NOT EXISTS(SELECT 1 FROM bot_attribution_jobs b JOIN messages bm ON bm.id=b.message_id WHERE b.status IN ('queued','running') AND bm.chat_id=c.id AND bm.message_index BETWEEN j.from_index AND j.through_index)
        AND (j.status='queued' OR (j.status='running' AND j.lease_until<now())) AND j.attempts<3 AND j.next_attempt_at<=now()
        ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`)
      ).rows[0];
      if (!row) return null;
      if (
        !row.progress_scope &&
        (row.request_key || row.reason !== "incremental")
      ) {
        const scope =
          row.reason === "rebuild" &&
          Number(row.cursor_index) < Number(row.from_index)
            ? "full"
            : "remaining";
        await this.initializeProgress(db, row.id, scope);
        // Samples collected without membership have zero message counts.
        await db.query(
          "UPDATE memory_jobs SET progress_samples='[]',progress_started_at=NULL,progress_last_at=NULL,progress_worker=NULL WHERE id=$1",
          [row.id],
        );
      }
      // Short new-message jobs interleave with a long backfill in an active
      // chat; they must not reset the backfill's timing samples, or its
      // estimate (and the dialog layout) would flicker after every one.
      if (row.reason !== "incremental") {
        await db.query(
          `UPDATE memory_jobs SET progress_samples='[]',progress_started_at=NULL,progress_worker=NULL WHERE id<>$1 AND progress_worker IS NOT NULL`,
          [row.id],
        );
        await db.query(
          `UPDATE memory_jobs SET progress_samples=CASE WHEN progress_worker=$2 AND progress_last_at>now()-interval '60 seconds' THEN progress_samples ELSE '[]'::jsonb END,
        progress_last_at=CASE WHEN progress_worker=$2 AND progress_last_at>now()-interval '60 seconds' THEN progress_last_at ELSE NULL END,progress_started_at=CASE WHEN progress_worker=$2 AND progress_last_at>now()-interval '60 seconds' THEN progress_started_at ELSE now() END,progress_worker=$2 WHERE id=$1`,
          [row.id, this.workerId],
        );
      }
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
  /** Messages that already have current vectors in this generation. */
  async indexedMessageIds(
    generationId: string,
    messageIds: readonly string[],
  ): Promise<Set<string>> {
    if (!messageIds.length) return new Set();
    const rows = await this.pool.query<{ message_id: string }>(
      "SELECT message_id FROM memory_indexed_messages WHERE generation_id=$1 AND message_id=ANY($2::uuid[])",
      [generationId, messageIds],
    );
    return new Set(rows.rows.map((r) => r.message_id));
  }
  async publish(
    job: MemoryJob,
    messages: MemoryMessage[],
    chunks: MemoryChunk[],
    vectors: number[][],
    scannedThrough?: number,
    /** Already indexed in this batch: counted as processed, not re-embedded. */
    skippedIds: readonly string[] = [],
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
          "SELECT * FROM memory_generations WHERE id=$1 AND status='active' FOR SHARE",
          [job.generation_id],
        )
      ).rows[0];
      if (!generation) throw new Error("MEMORY_GENERATION_UNAVAILABLE");
      const authorization = await db.query(
        "SELECT 1 FROM memory_chats mc JOIN chats c ON c.id=mc.chat_id WHERE c.id=$1 AND mc.enabled AND c.enabled AND c.deleted_at IS NULL AND EXISTS(SELECT 1 FROM memory_settings WHERE enabled) FOR SHARE OF mc,c",
        [job.chat_id],
      );
      if (!authorization.rowCount) throw new Error("MEMORY_DISABLED");
      const layout = vectorLayout(generation.config);
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
          `INSERT INTO memory_embeddings(chunk_id,dimensions,${layout.column},chat_id,generation_id) VALUES($1,$2,$3::${layout.type},$4,$5)
          ON CONFLICT(chunk_id) DO UPDATE SET dimensions=EXCLUDED.dimensions,embedding=EXCLUDED.embedding,embedding_half=EXCLUDED.embedding_half,
          chat_id=EXCLUDED.chat_id,generation_id=EXCLUDED.generation_id`,
          [
            chunkId,
            layout.dimensions,
            JSON.stringify(vector),
            job.chat_id,
            job.generation_id,
          ],
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
      if (skippedIds.length) {
        // A skipped message must still be indexed; an edit in between clears
        // the marker, so retry the batch instead of leaving a silent gap.
        const still = await db.query(
          "SELECT 1 FROM memory_indexed_messages WHERE generation_id=$1 AND message_id=ANY($2::uuid[])",
          [job.generation_id, skippedIds],
        );
        if ((still.rowCount ?? 0) !== new Set(skippedIds).size)
          throw new Error("MEMORY_SOURCE_CHANGED");
      }
      const completed = await db.query<{ characters: number }>(
        `UPDATE memory_job_items SET state='processed' WHERE job_id=$1 AND state='pending' AND message_id=ANY($2::uuid[]) RETURNING characters`,
        [job.id, [...messages.map((m) => m.id), ...skippedIds]],
      );
      // Items skipped by the gap jump were indexed by another job meanwhile.
      await db.query(
        `UPDATE memory_job_items i SET state='processed' WHERE job_id=$1 AND state='pending' AND message_index<=$2
        AND EXISTS(SELECT 1 FROM memory_indexed_messages x WHERE x.message_id=i.message_id AND x.generation_id=$3)`,
        [job.id, cursor, job.generation_id],
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
        reason=CASE WHEN $2<through_index AND reason!='rebuild' THEN 'backfill' ELSE reason END,attempts=0,auto_retries=0,auto_retry_until=NULL,error_code=NULL,
        lease_owner=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE id=$1`,
        [job.id, cursor],
      );
    });
    if (vectors.length) await this.wakeRetries();
  }
  /**
   * Three quick retries, then: upstream failures (5xx, 429, timeout,
   * connection) wait 5 → 15 → 60 minutes and keep retrying for 24 hours;
   * anything else, or an expired retry window, stops as failed.
   */
  async fail(job: MemoryJob, code: string, detail?: EmbeddingFailureDetail) {
    await this.pool.query(
      `UPDATE memory_jobs SET
        status=CASE WHEN attempts<3 THEN 'queued'
          WHEN $5 AND COALESCE(auto_retry_until,now()+interval '24 hours')>now() THEN 'queued' ELSE 'failed' END,
        auto_retries=CASE WHEN attempts>=3 AND $5 THEN auto_retries+1 ELSE auto_retries END,
        auto_retry_until=CASE WHEN $5 THEN COALESCE(auto_retry_until,now()+interval '24 hours') ELSE auto_retry_until END,
        next_attempt_at=CASE WHEN attempts<3 THEN now()+interval '10 seconds'*attempts
          ELSE now()+CASE auto_retries WHEN 0 THEN interval '5 minutes' WHEN 1 THEN interval '15 minutes' ELSE interval '60 minutes' END END,
        attempts=CASE WHEN attempts>=3 AND $5 THEN 0 ELSE attempts END,
        reason=CASE WHEN reason='rebuild' THEN reason ELSE 'backfill' END,error_code=$3,error_detail=COALESCE($4::jsonb,'{}'::jsonb)||jsonb_build_object('at',now()),
        progress_worker=NULL,progress_samples='[]',progress_started_at=NULL,progress_last_at=NULL,lease_owner=NULL,lease_until=NULL,version=version+1,updated_at=now()
      WHERE id=$1 AND lease_owner=$2 AND status='running'`,
      [
        job.id,
        job.lease_owner,
        code,
        detail ? JSON.stringify(detail) : null,
        isUpstreamFailure(code, detail),
      ],
    );
  }
  /** The service answered again: run jobs waiting on an upstream retry now. */
  async wakeRetries() {
    await this.pool.query(
      "UPDATE memory_jobs SET next_attempt_at=now() WHERE status='queued' AND auto_retries>0 AND next_attempt_at>now()",
    );
  }
  async excerpt(scope: MemoryScope, chunkId: string): Promise<MemoryMessage[]> {
    const rows = await this.pool.query<{
      message_index: string;
      source_hash: string;
      start_offset: number;
      end_offset: number;
    }>(
      `SELECT m.message_index,s.source_hash,s.start_offset,s.end_offset FROM memory_chunks c JOIN memory_chunk_sources s ON s.chunk_id=c.id JOIN messages m ON m.id=s.message_id WHERE c.id=$1 AND c.chat_id=$2 AND c.generation_id=$3 AND c.valid AND c.bot_identity_revision=(SELECT bot_identity_revision FROM chats WHERE id=c.chat_id) AND NOT (SELECT bot_memory_rebuild_required FROM chats WHERE id=c.chat_id) AND c.through_index<$4 AND m.content_redacted_at IS NULL AND execution_history_allows($5,m.id) ORDER BY m.message_index,s.start_offset`,
      [
        chunkId,
        scope.chatId,
        scope.generation.id,
        scope.upperIndex,
        scope.sentTimeBoundary ? scope.executionId : null,
      ],
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
      if (scope.sentTimeBoundary && message.replyTo) {
        const preview = (
          await this.pool.query<{ reply: MemoryMessage["replyTo"] }>(
            "SELECT execution_reply_preview($1,$2,0,$3) AS reply",
            [message.id, scope.executionId, scope.upperIndex],
          )
        ).rows[0]?.reply;
        if (preview) message.replyTo = preview;
        else delete message.replyTo;
      }
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
      `SELECT ${scopedMessageColumns("$8", "$2")} FROM messages m
      WHERE m.chat_id=$1 AND m.message_index<$2 AND m.content_redacted_at IS NULL AND execution_history_allows($8,m.id)
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
        scope.sentTimeBoundary ? scope.executionId : null,
      ],
    );
    const tokens = keywordTokens(query.query);
    return rows.rows
      .map(memoryMessage)
      .filter((m) => tokens.some((t) => m.text.toLowerCase().includes(t)))
      .slice(0, query.limit ?? executionPolicy.search.limit);
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
  async candidates(
    scope: MemoryScope,
    query: MemorySearch,
    vector: number[] | null,
  ): Promise<Candidate[]> {
    const tokens = keywordTokens(query.query).slice(0, 40);
    if (!vector && !tokens.length) return [];
    const scopeFilter = `c.chat_id=$1 AND c.generation_id=$2 AND c.through_index<$3 AND c.valid AND c.bot_identity_revision=(SELECT bot_identity_revision FROM chats WHERE id=c.chat_id) AND NOT (SELECT bot_memory_rebuild_required FROM chats WHERE id=c.chat_id)`;
    const sourceFilter = `NOT EXISTS(SELECT 1 FROM memory_chunk_sources s JOIN messages m ON m.id=s.message_id WHERE s.chunk_id=c.id AND (m.content_redacted_at IS NOT NULL OR NOT execution_history_allows($9,m.id) OR ($4::timestamptz IS NOT NULL AND m.sent_at<$4) OR ($5::timestamptz IS NOT NULL AND m.sent_at>$5)))
      AND ($6::text IS NULL OR EXISTS(SELECT 1 FROM memory_chunk_sources s JOIN messages m ON m.id=s.message_id WHERE s.chunk_id=c.id AND m.sender_id=$6)) AND ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM memory_chunk_sources s JOIN message_bot_attributions a ON a.message_id=s.message_id WHERE s.chunk_id=c.id AND a.workflow_id=$8))`;
    const filter = `${scopeFilter} AND ${sourceFilter}`;
    const limit = executionPolicy.search.candidates;
    const parameters = [
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
      scope.sentTimeBoundary ? scope.executionId : null,
    ];
    if (!vector)
      return (
        await this.pool.query<Candidate>(
          `SELECT c.id,c.from_index,c.through_index FROM memory_chunks c WHERE ${filter} AND c.keywords @@ to_tsquery('simple',$7) ORDER BY ts_rank(c.keywords,to_tsquery('simple',$7)) DESC,c.id LIMIT ${limit}`,
          parameters,
        )
      ).rows;
    // Nearest neighbours of this chat and generation, ranked on the typed
    // expression the HNSW index is built on (exact scan when the planner
    // prefers it for a small chat). Per-source checks then run on that pool
    // only. Identity or time filters can discard most nearest chunks, so
    // they rank every chunk of the chat exactly instead.
    const layout = vectorLayout(scope.generation.config);
    const narrow = !!(
      query.senderId ||
      query.botWorkflowId ||
      query.from ||
      query.to
    );
    const pool = limit * 5;
    const sql = `WITH nearest AS MATERIALIZED (
        SELECT e.chunk_id,e.${layout.expression} <=> $7::${layout.type}(${layout.dimensions}) AS distance
        FROM memory_embeddings e
        WHERE e.generation_id=$2 AND e.chat_id=$1 AND e.${layout.predicate.replace(" AND ", " AND e.")}
        ORDER BY distance ${narrow ? "" : `LIMIT ${pool}`})
      SELECT c.id,c.from_index,c.through_index FROM nearest n JOIN memory_chunks c ON c.id=n.chunk_id
      WHERE ${filter} ORDER BY n.distance LIMIT ${limit}`;
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      // Keep walking the index until enough rows pass the chat filter.
      await db.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
      await db.query(`SET LOCAL hnsw.ef_search = ${pool}`);
      const rows = (await db.query<Candidate>(sql, parameters)).rows;
      await db.query("COMMIT");
      return rows;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      db.release();
    }
  }
}

interface HealthRow {
  chat_id: string;
  enabled: boolean;
  rebuild: boolean;
  total: number;
  indexed: number;
  missing: number;
  active_jobs: number;
  retry_at: Date | null;
  progress_total: number;
  progress_done: number;
  error_code: string | null;
  error_detail: (EmbeddingFailureDetail & { at?: string }) | null;
  error_at: Date | null;
}
export type MemoryHealthState =
  | "disabled"
  | "global-off"
  | "rebuild-required"
  | "indexing"
  | "service-error"
  | "missing"
  | "healthy";
export interface MemoryChatHealth {
  chatId: string;
  enabled: boolean;
  state: MemoryHealthState;
  total: number;
  indexed: number;
  missing: number;
  progress: { total: number; done: number; percent: number } | null;
  /** Next automatic retry while the embedding service is failing. */
  retryAt: string | null;
  error: {
    code: string;
    detail: EmbeddingFailureDetail | null;
    at: string | null;
  } | null;
}
export interface MemoryHealthView {
  globalEnabled: boolean;
  generation: {
    id: string;
    model: string;
    dimensions: number;
    precision: string;
  } | null;
  chats: MemoryChatHealth[];
}
function chatHealth(r: HealthRow, globalEnabled: boolean): MemoryChatHealth {
  const upstream = r.error_code
    ? isUpstreamFailure(r.error_code, r.error_detail)
    : false;
  const state: MemoryHealthState = !r.enabled
    ? "disabled"
    : !globalEnabled
      ? "global-off"
      : r.rebuild
        ? "rebuild-required"
        : r.active_jobs
          ? "indexing"
          : r.retry_at || (r.missing && upstream)
            ? "service-error"
            : r.missing
              ? "missing"
              : "healthy";
  return {
    chatId: r.chat_id,
    enabled: r.enabled,
    state,
    total: r.total,
    indexed: r.indexed,
    missing: r.missing,
    progress: r.progress_total
      ? {
          total: r.progress_total,
          done: r.progress_done,
          percent: Math.floor((r.progress_done / r.progress_total) * 100),
        }
      : null,
    retryAt: r.retry_at?.toISOString() ?? null,
    error:
      r.error_code && (state === "service-error" || state === "missing")
        ? {
            code: r.error_code,
            detail: r.error_detail,
            at: r.error_at?.toISOString() ?? null,
          }
        : null,
  };
}
