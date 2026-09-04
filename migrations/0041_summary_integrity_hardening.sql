-- A workflow-scoped state must never become the authoritative chat summary.
-- Preserve all of its historical operations under a legacy namespace, stop
-- unfinished work, and let the runtime create a new empty chat-level state
-- that rebuilds from archived messages.
WITH superseded AS (
  UPDATE conversation_context_compressions operation
  SET status = 'superseded',
      error_code = 'CONTEXT_SUMMARY_LEGACY_STATE',
      completed_at = NOW(),
      lease_owner = NULL,
      updated_at = NOW()
  FROM conversation_context_states state
  WHERE operation.context_state_id = state.id
    AND state.instance_namespace = 'default'
    AND (state.workflow_id IS NOT NULL OR state.node_id IS NOT NULL)
    AND operation.status IN ('queued', 'running')
  RETURNING operation.id
)
INSERT INTO conversation_context_compression_events (
  id, compression_id, status, error_code, metadata
)
SELECT gen_random_uuid(), id, 'superseded',
       'CONTEXT_SUMMARY_LEGACY_STATE',
       '{"source":"summary-integrity-migration"}'::jsonb
FROM superseded;

UPDATE conversation_context_states
SET instance_namespace = 'legacy:' || id::text,
    legacy = TRUE,
    status = 'idle',
    rebuilding = FALSE,
    updated_at = NOW()
WHERE instance_namespace = 'default'
  AND (workflow_id IS NOT NULL OR node_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS conversation_context_states_chat_runtime_idx
  ON conversation_context_states (chat_id, summary_policy_version, rebuilding)
  WHERE instance_namespace = 'default' AND legacy = FALSE;
