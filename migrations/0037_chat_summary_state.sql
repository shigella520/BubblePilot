ALTER TABLE conversation_context_states
  ALTER COLUMN workflow_id DROP NOT NULL,
  ALTER COLUMN node_id DROP NOT NULL;

ALTER TABLE conversation_context_states
  DROP CONSTRAINT IF EXISTS conversation_context_states_instance_namespace_chat_id_workflow_id_node_id_profile_hash_key;

-- A previous interrupted/manual migration may have left the replacement index
-- behind even though the migration itself was not recorded as applied.
DROP INDEX IF EXISTS conversation_context_states_chat_profile_key;

-- Older installations can contain several workflow/node states with the same
-- chat/profile. Keep the most advanced state before enforcing chat-level
-- uniqueness; dependent compression attempts are removed with the discarded
-- state via the existing foreign-key cascade.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY instance_namespace, chat_id, profile_hash
           ORDER BY covered_through_index DESC, version DESC, updated_at DESC, id DESC
         ) AS rn
  FROM conversation_context_states
)
DELETE FROM conversation_context_states state
USING ranked
WHERE state.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX conversation_context_states_chat_profile_key
  ON conversation_context_states (instance_namespace, chat_id, profile_hash);

ALTER TABLE conversation_context_compressions
  ALTER COLUMN execution_id DROP NOT NULL;

ALTER TABLE ai_provider_attempts
  DROP CONSTRAINT IF EXISTS ai_provider_attempts_owner_check;

ALTER TABLE ai_provider_attempts
  ALTER COLUMN node_id DROP NOT NULL;

ALTER TABLE ai_provider_attempts
  ADD CONSTRAINT ai_provider_attempts_owner_check CHECK (
    (purpose IN ('context-summary', 'image-summary')
      AND execution_id IS NULL AND background_operation_id IS NOT NULL)
    OR
    (purpose = 'workflow-reply'
      AND execution_id IS NOT NULL AND background_operation_id IS NULL)
  );
