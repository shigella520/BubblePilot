-- Summary settings now control future compression only. Stop the retired
-- full-history policy rebuild loop; the in-process worker will perform one
-- normal backlog threshold check for each enabled chat after startup.
WITH stopped AS (
  UPDATE conversation_context_compressions
  SET status = 'superseded',
      error_code = 'CONTEXT_SUMMARY_POLICY_REBUILD_RETIRED',
      completed_at = NOW(),
      lease_owner = NULL,
      updated_at = NOW()
  WHERE reason = 'policy-rebuild'
    AND status IN ('queued', 'running')
  RETURNING id
)
INSERT INTO conversation_context_compression_events (
  id, compression_id, status, error_code, metadata
)
SELECT gen_random_uuid(), id, 'superseded',
       'CONTEXT_SUMMARY_POLICY_REBUILD_RETIRED',
       '{"source":"policy-rebuild-retirement"}'::jsonb
FROM stopped;

UPDATE conversation_context_states state
SET rebuilding = FALSE,
    status = 'idle',
    updated_at = NOW()
WHERE (state.rebuilding = TRUE OR state.status = 'compressing')
  AND NOT EXISTS (
    SELECT 1
    FROM conversation_context_compressions operation
    WHERE operation.context_state_id = state.id
      AND operation.status = 'running'
  );

DROP INDEX IF EXISTS conversation_context_states_rebuilding_idx;
DROP INDEX IF EXISTS conversation_context_states_chat_runtime_idx;

ALTER TABLE conversation_context_states
  DROP COLUMN IF EXISTS rebuilding;

CREATE INDEX IF NOT EXISTS conversation_context_states_chat_runtime_idx
  ON conversation_context_states (chat_id, summary_policy_version)
  WHERE instance_namespace = 'default' AND legacy = FALSE;
