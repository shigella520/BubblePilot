-- 0038 consolidates the runtime summary scope from workflow/node to chat. Move
-- duplicate workflow-scoped states out of the default runtime namespace before
-- that migration creates its chat-level unique key. Keeping the rows preserves
-- their ON DELETE CASCADE compression history for audit and diagnosis.
DO $$
BEGIN
  -- An installation that already applied 0038 receives this newly inserted
  -- preflight migration as a no-op. Its consolidation has already happened.
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'conversation_context_states'
      AND column_name = 'summary_policy_version'
  ) THEN
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY instance_namespace, chat_id
               ORDER BY covered_through_index DESC, version DESC, updated_at DESC, id DESC
             ) AS rn
      FROM conversation_context_states
    )
    UPDATE conversation_context_states state
    SET instance_namespace = 'legacy:' || state.id::text,
        updated_at = NOW()
    FROM ranked
    WHERE state.id = ranked.id
      AND ranked.rn > 1;
  END IF;
END $$;
