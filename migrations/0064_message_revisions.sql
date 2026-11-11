ALTER TABLE messages
  ADD COLUMN revision_state TEXT NOT NULL DEFAULT 'active'
    CHECK (revision_state IN ('active','retracted','partial','unresolved')),
  ADD COLUMN revision_number BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN edited_at TIMESTAMPTZ,
  ADD COLUMN revision_source_at TIMESTAMPTZ,
  ADD COLUMN revision_hash TEXT,
  ADD COLUMN reply_target_guid TEXT,
  ADD COLUMN reply_part TEXT;

CREATE TABLE message_revision_jobs (
  id UUID PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  provider_message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('revision','reply')),
  correlation_id UUID NOT NULL,
  source_time TIMESTAMPTZ,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','applied','ignored','failed')),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX message_revision_jobs_due ON message_revision_jobs(next_attempt_at) WHERE status IN ('pending','running');
CREATE INDEX message_revision_jobs_target ON message_revision_jobs(provider_message_id);

-- No quoted bodies are stored: every expansion obeys the caller's read window.
CREATE FUNCTION message_reply_preview(source_id UUID, lower_index BIGINT, upper_index BIGINT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE target public.messages%ROWTYPE;
  source public.messages%ROWTYPE;
BEGIN
  SELECT * INTO source FROM public.messages WHERE id=source_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF source.reply_target_guid IS NULL THEN RETURN NULL; END IF;
  IF source.content_redacted_at IS NOT NULL OR source.revision_state IN ('retracted','unresolved') THEN
    RETURN jsonb_build_object('status','unavailable');
  END IF;
  SELECT m.* INTO target FROM public.messages m JOIN public.chats c ON c.id=m.chat_id
    WHERE m.provider=source.provider AND m.provider_message_id=source.reply_target_guid
    AND m.chat_id=source.chat_id AND c.enabled AND c.deleted_at IS NULL
    AND m.message_index>lower_index AND m.message_index<upper_index
    AND m.content_redacted_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  IF target.revision_state='retracted' THEN
    RETURN jsonb_build_object('status','retracted','message_id',target.provider_message_id);
  END IF;
  -- Exact multipart mapping is deliberately not guessed. Plain single text
  -- quotes can be expanded only after the supplier explicitly identifies part 0.
  IF target.revision_state IN ('partial','unresolved') OR source.reply_part IS DISTINCT FROM '0'
    OR target.attachments <> '[]'::jsonb THEN
    RETURN jsonb_build_object('status','unresolved','message_id',target.provider_message_id);
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('status','available',
    'message_id',target.provider_message_id,'archive_id',target.id,'message_index',target.message_index,
    'sender_id',target.sender_id,'author',bot_message_author(target.id),'part_id',source.reply_part,
    'text_preview',left(target.body,400),'truncated',CASE WHEN target.body IS NULL THEN NULL ELSE length(target.body)>400 END));
END $$;

-- Reuse transactional memory invalidation even when only state changes.
CREATE TRIGGER memory_message_revision AFTER UPDATE OF revision_state ON messages
  FOR EACH ROW WHEN (OLD.revision_state IS DISTINCT FROM NEW.revision_state)
  EXECUTE FUNCTION memory_message_changed();
