ALTER TABLE conversation_summary_settings
  ADD COLUMN IF NOT EXISTS include_from_me BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE conversation_context_states
  ADD COLUMN IF NOT EXISTS summary_policy_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_compression_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_provider_id UUID,
  ADD COLUMN IF NOT EXISTS last_model TEXT,
  ADD COLUMN IF NOT EXISTS contract_version TEXT,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS legacy BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE conversation_context_compressions
  DROP CONSTRAINT IF EXISTS conversation_context_compressions_status_check;
ALTER TABLE conversation_context_compressions
  ADD CONSTRAINT conversation_context_compressions_status_check
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'superseded'));
ALTER TABLE conversation_context_compressions
  ADD COLUMN IF NOT EXISTS summary_policy_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS correlation_id UUID,
  ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'message-threshold',
  ADD COLUMN IF NOT EXISTS provider_id UUID,
  ADD COLUMN IF NOT EXISTS route_id UUID,
  ADD COLUMN IF NOT EXISTS provider_name TEXT,
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DROP INDEX IF EXISTS conversation_context_states_chat_profile_key;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY instance_namespace, chat_id, summary_policy_version
           ORDER BY covered_through_index DESC, version DESC, updated_at DESC, id DESC
         ) AS rn
  FROM conversation_context_states
)
DELETE FROM conversation_context_states state
USING ranked
WHERE state.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_context_states_chat_policy_key
  ON conversation_context_states (instance_namespace, chat_id, summary_policy_version);
CREATE INDEX IF NOT EXISTS conversation_context_compressions_queue_idx
  ON conversation_context_compressions (status, lease_expires_at, started_at);

ALTER TABLE workflow_executions
  ADD COLUMN IF NOT EXISTS trigger_message_index BIGINT,
  ADD COLUMN IF NOT EXISTS context_snapshot JSONB;

CREATE INDEX IF NOT EXISTS workflow_executions_trigger_message_idx
  ON workflow_executions (provider, trigger_message_index);

UPDATE conversation_context_states
SET summary_policy_version = 1
WHERE summary_policy_version IS NULL;

UPDATE conversation_context_compressions
SET summary_policy_version = 1
WHERE summary_policy_version IS NULL;
