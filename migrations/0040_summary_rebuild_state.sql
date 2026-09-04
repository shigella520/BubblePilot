ALTER TABLE conversation_context_states
  ADD COLUMN IF NOT EXISTS rebuilding BOOLEAN NOT NULL DEFAULT FALSE;

-- 0039 attempted to drop this legacy full-range UNIQUE constraint by its
-- pre-truncation name. PostgreSQL's generated identifier can be truncated
-- differently, leaving failed operations to block a retry of the same range.
-- Resolve it by constrained columns instead of relying on the generated name.
DO $$
DECLARE
  legacy_constraint RECORD;
BEGIN
  FOR legacy_constraint IN
    SELECT constraint_row.conname
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'conversation_context_compressions'::regclass
      AND constraint_row.contype = 'u'
      AND (
        SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
        FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
        INNER JOIN pg_attribute attribute
          ON attribute.attrelid = constraint_row.conrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['context_state_id', 'base_version', 'from_index', 'through_index']::name[]
  LOOP
    EXECUTE format(
      'ALTER TABLE conversation_context_compressions DROP CONSTRAINT %I',
      legacy_constraint.conname
    );
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_context_compressions_active_range_key
  ON conversation_context_compressions (context_state_id, base_version, from_index, through_index)
  WHERE status IN ('queued', 'running');

-- Recover states left as compressing when their operation already reached a
-- terminal state. Future failures reset this in the same transaction.
UPDATE conversation_context_states state
SET status = 'idle', updated_at = NOW()
WHERE state.status = 'compressing'
  AND NOT EXISTS (
    SELECT 1
    FROM conversation_context_compressions operation
    WHERE operation.context_state_id = state.id
      AND operation.status = 'running'
  );

UPDATE conversation_context_states
SET legacy = TRUE, updated_at = NOW()
WHERE instance_namespace LIKE 'legacy:%'
  AND legacy = FALSE;

CREATE INDEX IF NOT EXISTS conversation_context_states_rebuilding_idx
  ON conversation_context_states (summary_policy_version, rebuilding, updated_at DESC)
  WHERE instance_namespace = 'default';
