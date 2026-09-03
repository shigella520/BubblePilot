ALTER TABLE conversation_context_states
  ALTER COLUMN workflow_id DROP NOT NULL,
  ALTER COLUMN node_id DROP NOT NULL;

ALTER TABLE conversation_context_states
  DROP CONSTRAINT IF EXISTS conversation_context_states_instance_namespace_chat_id_workflow_id_node_id_profile_hash_key;

-- A previous interrupted/manual migration may have left the replacement index
-- behind even though the migration itself was not recorded as applied.
DROP INDEX IF EXISTS conversation_context_states_chat_profile_key;

-- Historical rows can contain duplicate chat/profile pairs. The follow-up
-- chat-level migration performs the data consolidation before enforcing
-- uniqueness, so this migration must remain safe on those installations.
CREATE INDEX conversation_context_states_chat_profile_key
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
