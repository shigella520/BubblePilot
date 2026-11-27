-- Long-term retrieval lifecycle (doc/迭代需求-长期检索易用性整改.md) and vector
-- storage (doc/迭代需求-性能优化.md P2).

-- Generations: record when a generation stopped serving so retired data can be
-- purged after a configurable retention; keep the row itself as 'purged'.
ALTER TABLE memory_generations ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
ALTER TABLE memory_generations DROP CONSTRAINT IF EXISTS memory_generations_status_check;
ALTER TABLE memory_generations ADD CONSTRAINT memory_generations_status_check
  CHECK (status IN ('building', 'active', 'retired', 'purged'));
UPDATE memory_generations SET retired_at = now() WHERE status = 'retired' AND retired_at IS NULL;

ALTER TABLE memory_settings ADD COLUMN IF NOT EXISTS generation_retention_days INTEGER NOT NULL DEFAULT 3
  CHECK (generation_retention_days BETWEEN 1 AND 90);

-- Upstream failures (5xx / 429 / timeout / network) keep retrying with backoff
-- for up to 24 hours instead of stopping after three attempts.
ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS auto_retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS auto_retry_until TIMESTAMPTZ;

-- New and changed messages are indexed only into the active generation. A
-- model change activates the new generation immediately and rebuilds from
-- zero, so there is no parallel "building" generation any more.
CREATE OR REPLACE FUNCTION memory_message_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected_from BIGINT := NEW.message_index;
  affected_through BIGINT := NEW.message_index;
  was_indexed BOOLEAN := FALSE;
BEGIN
  IF TG_OP='UPDATE' THEN
    SELECT EXISTS(SELECT 1 FROM memory_indexed_messages WHERE message_id=NEW.id) INTO was_indexed;
    SELECT LEAST(NEW.message_index,COALESCE(min(c.from_index),NEW.message_index)),
      GREATEST(NEW.message_index,COALESCE(max(c.through_index),NEW.message_index))
      INTO affected_from,affected_through FROM memory_chunks c
      JOIN memory_chunk_sources s ON s.chunk_id=c.id WHERE s.message_id=NEW.id AND c.valid;
    DELETE FROM memory_indexed_messages i USING memory_chunk_sources s,memory_chunks c
      WHERE i.message_id=s.message_id AND i.generation_id=c.generation_id AND s.chunk_id=c.id
      AND c.id IN (SELECT chunk_id FROM memory_chunk_sources WHERE message_id=NEW.id);
    UPDATE memory_chunks SET valid=FALSE,text=NULL,keywords=''::tsvector
      WHERE id IN (SELECT chunk_id FROM memory_chunk_sources WHERE message_id=NEW.id);
    DELETE FROM memory_indexed_messages WHERE message_id=NEW.id;
  END IF;
  IF (NEW.content_redacted_at IS NULL OR affected_from<>affected_through) AND EXISTS(SELECT 1 FROM memory_settings WHERE enabled) THEN
    INSERT INTO memory_jobs(chat_id,generation_id,reason,from_index,through_index,cursor_index,next_attempt_at)
      SELECT NEW.chat_id,g.id,'incremental',affected_from,affected_through,affected_from-1,now()+interval '60 seconds'
      FROM memory_generations g JOIN memory_chats mc ON mc.chat_id=NEW.chat_id AND mc.enabled
      JOIN chats c ON c.id=mc.chat_id AND c.enabled AND c.deleted_at IS NULL
      WHERE g.status = 'active'
        AND (NEW.message_index>=mc.from_index OR was_indexed)
      ON CONFLICT(chat_id,generation_id) WHERE reason='incremental' AND status='queued'
      DO UPDATE SET from_index=LEAST(memory_jobs.from_index,EXCLUDED.from_index),
        cursor_index=LEAST(memory_jobs.cursor_index,EXCLUDED.cursor_index),
        through_index=GREATEST(memory_jobs.through_index,EXCLUDED.through_index),
        next_attempt_at=now()+interval '60 seconds',updated_at=now();
  END IF;
  RETURN NEW;
END $$;

-- Vector storage: keep float32 (`embedding`, indexable up to 2000 dims) and add
-- float16 (`embedding_half`, indexable up to 4000 dims); each row uses exactly
-- one, chosen by the generation's configured precision. chat_id and
-- generation_id are copied from the chunk so per-chat vector search can filter
-- on the embedding row itself (HNSW index + iterative scan). The HNSW index for
-- a generation's dimension/precision is created when the generation is
-- created. memory_embeddings is created by prepare-memory, so only alter it
-- when it already exists.
DO $$
DECLARE con record;
BEGIN
  IF to_regclass('public.memory_embeddings') IS NOT NULL THEN
    ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS embedding_half halfvec;
    ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS chat_id UUID;
    ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS generation_id UUID;
    UPDATE memory_embeddings e SET chat_id = k.chat_id, generation_id = k.generation_id
      FROM memory_chunks k WHERE k.id = e.chunk_id AND e.chat_id IS NULL;
    ALTER TABLE memory_embeddings ALTER COLUMN chat_id SET NOT NULL;
    ALTER TABLE memory_embeddings ALTER COLUMN generation_id SET NOT NULL;
    ALTER TABLE memory_embeddings ALTER COLUMN embedding DROP NOT NULL;
    FOR con IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'public.memory_embeddings'::regclass AND contype = 'c' LOOP
      EXECUTE format('ALTER TABLE memory_embeddings DROP CONSTRAINT %I', con.conname);
    END LOOP;
    ALTER TABLE memory_embeddings ADD CONSTRAINT memory_embeddings_vector_check CHECK (
      (embedding IS NULL) <> (embedding_half IS NULL)
      AND dimensions BETWEEN 1 AND 16000
      AND dimensions = CASE WHEN embedding IS NOT NULL THEN vector_dims(embedding) ELSE vector_dims(embedding_half) END);
    CREATE INDEX IF NOT EXISTS memory_embeddings_scope_idx ON memory_embeddings (generation_id, chat_id);
  END IF;
END $$;

-- Saved configs gain an explicit precision; without it an unchanged save
-- would look like a model change. Existing vectors are float32 (`embedding`).
UPDATE memory_generations SET config = config || '{"precision":"float32"}'::jsonb WHERE NOT config ? 'precision';
UPDATE memory_settings SET config = config || '{"precision":"float32"}'::jsonb WHERE NOT config ? 'precision';
-- Enabled chats are fully backfilled now, so edits to any message re-index.
UPDATE memory_chats SET from_index = 0 WHERE enabled;
CREATE INDEX IF NOT EXISTS memory_jobs_retry_idx ON memory_jobs (next_attempt_at)
  WHERE status = 'queued' AND auto_retries > 0;

-- Execution detail retention (doc/迭代需求-性能优化.md P3): node, tool, route
-- and image-input details of finished executions are deleted after this many
-- days. Execution rows, deliveries, attributions and usage counts are kept.
CREATE TABLE IF NOT EXISTS data_retention_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  execution_detail_days INTEGER NOT NULL DEFAULT 90 CHECK (execution_detail_days BETWEEN 7 AND 3650),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO data_retention_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS details_purged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS workflow_executions_detail_retention_idx
  ON workflow_executions (completed_at) WHERE details_purged_at IS NULL AND completed_at IS NOT NULL;
