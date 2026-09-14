-- Destructive retirement: stop the previous application before applying this migration.
CREATE TABLE conversation_context_settings (
 id SMALLINT PRIMARY KEY CHECK(id=1), include_from_me BOOLEAN NOT NULL DEFAULT TRUE,
 base_message_window INTEGER NOT NULL DEFAULT 10 CHECK(base_message_window BETWEEN 1 AND 50),
 redundancy_message_window INTEGER NOT NULL DEFAULT 10 CHECK(redundancy_message_window BETWEEN 1 AND 50),
 character_limit INTEGER NOT NULL DEFAULT 6000 CHECK(character_limit BETWEEN 100 AND 20000),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO conversation_context_settings(id,include_from_me,base_message_window,redundancy_message_window,character_limit,version,updated_at)
 SELECT id,include_from_me,base_message_window,redundancy_message_window,character_limit,version,updated_at FROM conversation_summary_settings;
-- Metadata only. A fixed trigger snapshot also makes duplicate ingestion idempotent.
CREATE TABLE conversation_context_windows (
 chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
 trigger_message_index BIGINT NOT NULL,
 snapshot JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(chat_id,trigger_message_index)
);
CREATE OR REPLACE FUNCTION bot_derived_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT bot_identity_revision INTO NEW.bot_identity_revision FROM chats WHERE id=NEW.chat_id;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION bot_invalidate_derived() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.bot_identity_revision<>OLD.bot_identity_revision THEN
   UPDATE memory_chunks SET valid=FALSE WHERE chat_id=NEW.id AND valid;
   DELETE FROM memory_indexed_messages i USING messages m WHERE i.message_id=m.id AND m.chat_id=NEW.id;
   UPDATE memory_jobs SET status='superseded',error_code='BOT_IDENTITY_CHANGED',lease_owner=NULL WHERE chat_id=NEW.id AND status IN ('queued','running','paused');
 END IF;
 RETURN NEW;
END $$;
DELETE FROM ai_provider_attempts WHERE purpose='context-summary';
DELETE FROM ai_route_traces WHERE purpose='context-summary';
-- Only known chat-summary slots are removed; image/link summary fields are untouched.
CREATE FUNCTION retire_chat_summary_snapshot(value JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN jsonb_typeof(value)='object' THEN
   (value - ARRAY['summary','historySummary','summarySnapshot','summaryVersion','summaryPolicyVersion','summaryCoveredThroughIndex','summaryStateId','stateId','coveredThroughIndex','summaryCharacters','summaryStateCacheHit','uncompressedMessageCount','usedPreviousSummary','compressionOperationId','scheduledCompressionOperationId'])
   || jsonb_build_object('chatSummaryRetired',true)
 ELSE value END
$$;
UPDATE workflow_executions SET context_snapshot=retire_chat_summary_snapshot(context_snapshot)
 WHERE context_snapshot IS NOT NULL;
UPDATE workflow_executions SET context_snapshot=jsonb_set(context_snapshot,'{historyCoverage}',(context_snapshot->'historyCoverage')-'summaryCoveredThroughIndex')
 WHERE jsonb_typeof(context_snapshot->'historyCoverage')='object';
UPDATE node_executions SET output_summary=retire_chat_summary_snapshot(output_summary), input_summary=retire_chat_summary_snapshot(input_summary)
 WHERE node_type='load-context';
UPDATE node_executions SET output_summary=jsonb_set(output_summary,'{historyCoverage}',(output_summary->'historyCoverage')-'summaryCoveredThroughIndex')
 WHERE node_type='load-context' AND jsonb_typeof(output_summary->'historyCoverage')='object';
UPDATE audit_events SET metadata='{"chatSummaryRetired":true}'::jsonb
 WHERE action LIKE 'conversation-summary.%' OR action='ai.summary.settings.update';
DROP FUNCTION retire_chat_summary_snapshot(JSONB);
DROP TABLE conversation_context_compression_events;
DROP TABLE conversation_context_summary_revisions;
DROP TABLE conversation_context_compressions;
DROP TABLE conversation_context_states;
DROP TABLE conversation_summary_settings;
ALTER TABLE chats DROP COLUMN bot_summary_rebuild_required, DROP COLUMN bot_summary_rebuild_through;
