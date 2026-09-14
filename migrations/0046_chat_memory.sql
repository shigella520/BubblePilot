CREATE TABLE memory_settings (
  id INTEGER PRIMARY KEY CHECK (id=1), enabled BOOLEAN NOT NULL DEFAULT FALSE,
  config JSONB NOT NULL, encrypted_secret TEXT, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE memory_generations (
  id UUID PRIMARY KEY, config JSONB NOT NULL, encrypted_secret TEXT,
  identity TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('building','active','retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX memory_one_active ON memory_generations ((status)) WHERE status='active';
CREATE TABLE memory_chats (
  chat_id UUID PRIMARY KEY REFERENCES chats(id), enabled BOOLEAN NOT NULL DEFAULT FALSE,
  from_index BIGINT NOT NULL, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE memory_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), chat_id UUID NOT NULL REFERENCES chats(id),
  generation_id UUID NOT NULL REFERENCES memory_generations(id),
  reason TEXT NOT NULL CHECK(reason IN ('incremental','backfill','rebuild')),
  from_index BIGINT NOT NULL, through_index BIGINT NOT NULL, cursor_index BIGINT NOT NULL,
  range_from TIMESTAMPTZ, range_to TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused','succeeded','failed','cancelled','superseded')),
  attempts INTEGER NOT NULL DEFAULT 0, lease_owner UUID, lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), error_code TEXT,
  version INTEGER NOT NULL DEFAULT 1, request_key UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX memory_incremental_queue ON memory_jobs(chat_id,generation_id) WHERE reason='incremental' AND status='queued';
CREATE TABLE memory_chunks (
  id UUID PRIMARY KEY, chat_id UUID NOT NULL REFERENCES chats(id), generation_id UUID NOT NULL REFERENCES memory_generations(id),
  from_index BIGINT NOT NULL, through_index BIGINT NOT NULL, text TEXT,
  keywords TSVECTOR NOT NULL DEFAULT ''::tsvector, content_hash TEXT NOT NULL,
  valid BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(generation_id,chat_id,from_index,through_index,content_hash)
);
CREATE INDEX memory_chunk_scope ON memory_chunks(chat_id,generation_id,through_index) WHERE valid;
CREATE INDEX memory_chunk_keywords ON memory_chunks USING GIN(keywords) WHERE valid;
CREATE TABLE memory_chunk_sources (
  chunk_id UUID NOT NULL REFERENCES memory_chunks(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id), source_hash TEXT NOT NULL,
  start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
  PRIMARY KEY(chunk_id,message_id,start_offset)
);
CREATE INDEX memory_sources_message ON memory_chunk_sources(message_id);
CREATE TABLE memory_indexed_messages (
  generation_id UUID NOT NULL REFERENCES memory_generations(id), message_id UUID NOT NULL REFERENCES messages(id),
  PRIMARY KEY(generation_id,message_id)
);
CREATE TABLE memory_retrievals (
  id UUID PRIMARY KEY, chat_id UUID NOT NULL REFERENCES chats(id), execution_id UUID,
  generation_id UUID NOT NULL REFERENCES memory_generations(id), upper_index BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started', mode TEXT, duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE memory_retrieval_sources (
  retrieval_id UUID NOT NULL REFERENCES memory_retrievals(id) ON DELETE CASCADE,
  ref TEXT NOT NULL, message_id UUID NOT NULL REFERENCES messages(id), source_hash TEXT NOT NULL,
  start_offset INTEGER NOT NULL DEFAULT 0, end_offset INTEGER,
  PRIMARY KEY(retrieval_id,ref,message_id)
);

CREATE FUNCTION memory_message_changed() RETURNS trigger LANGUAGE plpgsql AS $$
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
      WHERE g.status IN ('active','building') AND (NEW.message_index>=mc.from_index OR was_indexed)
      ON CONFLICT(chat_id,generation_id) WHERE reason='incremental' AND status='queued'
      DO UPDATE SET from_index=LEAST(memory_jobs.from_index,EXCLUDED.from_index),
        cursor_index=LEAST(memory_jobs.cursor_index,EXCLUDED.cursor_index),
        through_index=GREATEST(memory_jobs.through_index,EXCLUDED.through_index),
        next_attempt_at=now()+interval '60 seconds',updated_at=now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_message_insert AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION memory_message_changed();
CREATE TRIGGER memory_message_update AFTER UPDATE OF body,attachments,link_previews,content_redacted_at ON messages
  FOR EACH ROW EXECUTE FUNCTION memory_message_changed();
CREATE FUNCTION memory_image_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Updating the existing canonical message invokes the same transactional invalidation.
  UPDATE messages SET body=body WHERE id=NEW.message_id;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_image_update AFTER INSERT OR UPDATE OF summary,status ON message_image_summaries
  FOR EACH ROW EXECUTE FUNCTION memory_image_changed();
