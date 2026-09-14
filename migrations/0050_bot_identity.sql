-- Workflow identity is stable; nicknames are versioned display metadata.
CREATE TABLE workflow_bot_identities (
  workflow_id UUID PRIMARY KEY REFERENCES workflows(id) ON DELETE RESTRICT,
  nickname TEXT NOT NULL CHECK(length(btrim(nickname)) BETWEEN 1 AND 120),
  first_nickname TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE workflow_executions ADD COLUMN bot_identity JSONB;
ALTER TABLE outbound_deliveries ADD COLUMN bot_identity JSONB;
CREATE TABLE message_bot_attributions (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  delivery_id UUID NOT NULL UNIQUE REFERENCES outbound_deliveries(id) ON DELETE RESTRICT,
  execution_id UUID NOT NULL REFERENCES workflow_executions(id) ON DELETE RESTRICT,
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
  workflow_version_id UUID NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
  node_id TEXT NOT NULL,
  nickname TEXT,
  identity_version INTEGER NOT NULL DEFAULT 0,
  basis TEXT NOT NULL CHECK(basis IN ('send-snapshot','historical-mapping')),
  revision INTEGER NOT NULL DEFAULT 1,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX message_bot_attributions_workflow ON message_bot_attributions(workflow_id,message_id);
CREATE INDEX outbound_delivery_message_origin ON outbound_deliveries(provider,provider_chat_id,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE TABLE bot_attribution_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  workflow_id UUID REFERENCES workflows(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed')),
  cursor_index BIGINT NOT NULL DEFAULT 0,
  through_index BIGINT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  linked INTEGER NOT NULL DEFAULT 0,
  unknown_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  lease_owner UUID, lease_until TIMESTAMPTZ,
  error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bot_attribution_message_pending ON bot_attribution_jobs(message_id) WHERE status IN ('queued','running') AND message_id IS NOT NULL;
ALTER TABLE chats ADD COLUMN bot_identity_revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN bot_summary_rebuild_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN bot_memory_rebuild_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversation_context_states ADD COLUMN bot_identity_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_context_compressions ADD COLUMN bot_identity_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_jobs ADD COLUMN bot_identity_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_chunks ADD COLUMN bot_identity_revision INTEGER NOT NULL DEFAULT 0;
-- No model invocation during migration. Existing derived history needs manual rebuilding.
UPDATE chats c SET bot_summary_rebuild_required=EXISTS(SELECT 1 FROM conversation_context_states s WHERE s.chat_id=c.id AND (s.summary<>'' OR s.covered_through_index>0)),
 bot_memory_rebuild_required=EXISTS(SELECT 1 FROM memory_chunks m WHERE m.chat_id=c.id);

UPDATE conversation_context_states s SET bot_identity_revision=c.bot_identity_revision FROM chats c WHERE c.id=s.chat_id AND s.summary='' AND s.covered_through_index=0;
UPDATE memory_chunks SET valid=FALSE WHERE valid;
DELETE FROM memory_indexed_messages;
UPDATE memory_jobs SET status='superseded',error_code='BOT_IDENTITY_FORMAT_UPGRADE',lease_owner=NULL WHERE status IN ('queued','running','paused');

CREATE FUNCTION bot_execution_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid UUID;
BEGIN
 IF NEW.retry_of_execution_id IS NOT NULL THEN
   SELECT bot_identity INTO NEW.bot_identity FROM workflow_executions WHERE id=NEW.retry_of_execution_id;
   RETURN NEW;
 END IF;
 SELECT workflow_id INTO wid FROM workflow_versions WHERE id=NEW.workflow_version_id;
 SELECT jsonb_build_object('workflowId',wid,'nickname',i.nickname,'version',coalesce(i.version,0)) INTO NEW.bot_identity
 FROM (SELECT 1) x LEFT JOIN workflow_bot_identities i ON i.workflow_id=wid;
 RETURN NEW;
END $$;
CREATE TRIGGER bot_execution_snapshot BEFORE INSERT ON workflow_executions FOR EACH ROW EXECUTE FUNCTION bot_execution_snapshot();
CREATE FUNCTION bot_delivery_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT bot_identity INTO NEW.bot_identity FROM workflow_executions WHERE id=NEW.execution_id;
 RETURN NEW;
END $$;
CREATE TRIGGER bot_delivery_snapshot BEFORE INSERT ON outbound_deliveries FOR EACH ROW EXECUTE FUNCTION bot_delivery_snapshot();
CREATE FUNCTION bot_queue_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='messages' THEN
   IF NEW.is_from_me THEN
     INSERT INTO bot_attribution_jobs(message_id,through_index) VALUES(NEW.id,NEW.message_index) ON CONFLICT DO NOTHING;
   END IF;
 ELSE
   INSERT INTO bot_attribution_jobs(message_id,through_index)
     SELECT m.id,m.message_index FROM messages m JOIN chats c ON c.id=m.chat_id
     WHERE m.is_from_me AND m.provider=NEW.provider AND m.provider_message_id=NEW.provider_message_id
       AND c.provider_chat_id=NEW.provider_chat_id ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bot_archive_queue AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION bot_queue_attribution();
CREATE TRIGGER bot_delivery_queue AFTER INSERT OR UPDATE OF provider_message_id ON outbound_deliveries FOR EACH ROW EXECUTE FUNCTION bot_queue_attribution();

ALTER TABLE messages ADD COLUMN bot_attribution_issue TEXT CHECK(bot_attribution_issue IN ('unmatched','ambiguous'));
CREATE FUNCTION bot_message_author(mid UUID) RETURNS JSONB LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN NOT m.is_from_me THEN jsonb_build_object('kind','participant','senderId',m.sender_id)
 WHEN a.message_id IS NULL THEN jsonb_build_object('kind','unknown-self','reason',m.bot_attribution_issue)
 ELSE jsonb_build_object('kind','bot','workflowId',a.workflow_id,'nickname',a.nickname,'version',a.identity_version,'basis',a.basis,'revision',a.revision) END
 FROM messages m LEFT JOIN message_bot_attributions a ON a.message_id=m.id WHERE m.id=mid
$$;
ALTER TABLE bot_attribution_jobs ADD COLUMN cursor_message UUID;
CREATE FUNCTION bot_derived_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid UUID;
BEGIN
 IF TG_TABLE_NAME='conversation_context_compressions' THEN
   SELECT chat_id INTO cid FROM conversation_context_states WHERE id=NEW.context_state_id;
 ELSE cid:=NEW.chat_id; END IF;
 SELECT bot_identity_revision INTO NEW.bot_identity_revision FROM chats WHERE id=cid;
 RETURN NEW;
END $$;
CREATE TRIGGER bot_state_revision BEFORE INSERT ON conversation_context_states FOR EACH ROW EXECUTE FUNCTION bot_derived_revision();
CREATE TRIGGER bot_compression_revision BEFORE INSERT ON conversation_context_compressions FOR EACH ROW EXECUTE FUNCTION bot_derived_revision();
CREATE TRIGGER bot_memory_job_revision BEFORE INSERT ON memory_jobs FOR EACH ROW EXECUTE FUNCTION bot_derived_revision();
CREATE TRIGGER bot_memory_chunk_revision BEFORE INSERT ON memory_chunks FOR EACH ROW EXECUTE FUNCTION bot_derived_revision();
ALTER TABLE chats ADD COLUMN bot_summary_rebuild_through BIGINT;
CREATE FUNCTION bot_invalidate_derived() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.bot_identity_revision<>OLD.bot_identity_revision THEN
   NEW.bot_summary_rebuild_through:=NULL;
   UPDATE memory_chunks SET valid=FALSE WHERE chat_id=NEW.id AND valid;
   DELETE FROM memory_indexed_messages i USING messages m WHERE i.message_id=m.id AND m.chat_id=NEW.id;
   UPDATE memory_jobs SET status='superseded',error_code='BOT_IDENTITY_CHANGED',lease_owner=NULL WHERE chat_id=NEW.id AND status IN ('queued','running','paused');
   UPDATE conversation_context_compressions p SET status='superseded',error_code='BOT_IDENTITY_CHANGED',lease_owner=NULL
     FROM conversation_context_states s WHERE s.id=p.context_state_id AND s.chat_id=NEW.id AND p.status IN ('queued','running');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bot_invalidate_derived BEFORE UPDATE OF bot_identity_revision ON chats FOR EACH ROW EXECUTE FUNCTION bot_invalidate_derived();
