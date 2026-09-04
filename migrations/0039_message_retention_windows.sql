ALTER TABLE conversation_summary_settings
  ADD COLUMN IF NOT EXISTS base_message_window SMALLINT,
  ADD COLUMN IF NOT EXISTS redundancy_message_window SMALLINT;

UPDATE conversation_summary_settings
SET base_message_window = COALESCE(base_message_window, message_limit),
    redundancy_message_window = COALESCE(
      redundancy_message_window,
      compression_batch_size
    )
WHERE id = 1;

ALTER TABLE conversation_summary_settings
  ALTER COLUMN base_message_window SET DEFAULT 10,
  ALTER COLUMN base_message_window SET NOT NULL,
  ALTER COLUMN redundancy_message_window SET DEFAULT 10,
  ALTER COLUMN redundancy_message_window SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversation_summary_settings_base_window_check'
  ) THEN
    ALTER TABLE conversation_summary_settings
      ADD CONSTRAINT conversation_summary_settings_base_window_check
      CHECK (base_message_window BETWEEN 1 AND 50);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversation_summary_settings_redundancy_window_check'
  ) THEN
    ALTER TABLE conversation_summary_settings
      ADD CONSTRAINT conversation_summary_settings_redundancy_window_check
      CHECK (redundancy_message_window BETWEEN 1 AND 50);
  END IF;
END $$;

ALTER TABLE conversation_context_compressions
  ADD COLUMN IF NOT EXISTS trigger_message_index BIGINT;
ALTER TABLE conversation_context_compressions
  ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE conversation_context_compressions
  ADD COLUMN IF NOT EXISTS time_zone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE conversation_context_compressions
  ADD COLUMN IF NOT EXISTS include_from_me BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE conversation_context_states
  ADD COLUMN IF NOT EXISTS last_compression_at TIMESTAMPTZ;

-- Operations created by the pre-worker implementation had no lease owner;
-- make them immediately reclaimable by the in-process worker on upgrade.
UPDATE conversation_context_compressions
SET status = 'queued', lease_owner = NULL, lease_expires_at = NOW(),
    updated_at = NOW()
WHERE status = 'running' AND lease_owner IS NULL;

CREATE TABLE IF NOT EXISTS conversation_context_summary_revisions (
  context_state_id UUID NOT NULL
    REFERENCES conversation_context_states (id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  summary TEXT NOT NULL,
  covered_through_index BIGINT NOT NULL CHECK (covered_through_index >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (context_state_id, version)
);

INSERT INTO conversation_context_summary_revisions (
  context_state_id, version, summary, covered_through_index
)
SELECT id, version, summary, covered_through_index
FROM conversation_context_states
ON CONFLICT (context_state_id, version) DO NOTHING;

CREATE INDEX IF NOT EXISTS conversation_context_summary_revisions_created_idx
  ON conversation_context_summary_revisions (context_state_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_context_compression_events (
  id UUID PRIMARY KEY,
  compression_id UUID NOT NULL
    REFERENCES conversation_context_compressions (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'superseded')
  ),
  error_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversation_context_compression_events_idx
  ON conversation_context_compression_events (compression_id, created_at);

UPDATE workflow_executions execution
SET trigger_message_index = message.message_index
FROM messages message
WHERE execution.source_message_id = message.id
  AND execution.trigger_message_index IS NULL;

CREATE INDEX IF NOT EXISTS conversation_context_compressions_trigger_idx
  ON conversation_context_compressions (context_state_id, trigger_message_index);
CREATE INDEX IF NOT EXISTS conversation_context_compressions_status_started_idx
  ON conversation_context_compressions (status, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS conversation_context_compressions_policy_status_idx
  ON conversation_context_compressions (summary_policy_version, status, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS conversation_context_compressions_state_range_idx
  ON conversation_context_compressions (context_state_id, from_index, through_index);
CREATE INDEX IF NOT EXISTS conversation_context_states_policy_updated_idx
  ON conversation_context_states (summary_policy_version, updated_at DESC);

-- Failed/superseded attempts may be retried for the same range, while a chat
-- can still have at most one queued/running operation for a given base range.
ALTER TABLE conversation_context_compressions
  DROP CONSTRAINT IF EXISTS conversation_context_compressions_context_state_id_base_version_from_index_through_index_key;
CREATE UNIQUE INDEX IF NOT EXISTS conversation_context_compressions_active_range_key
  ON conversation_context_compressions (context_state_id, base_version, from_index, through_index)
  WHERE status IN ('queued', 'running');

ALTER TABLE workflow_versions
  ADD COLUMN IF NOT EXISTS needs_resave BOOLEAN NOT NULL DEFAULT FALSE;

-- Remove legacy node-level summary settings in-place. Versions that contained
-- them are marked so the editor can require an explicit save before publish.
UPDATE workflow_versions
SET definition = jsonb_set(
      definition,
      '{nodes}',
      (
        SELECT jsonb_agg(
          CASE WHEN node->>'type' = 'load-context'
            THEN jsonb_set(node, '{config}', '{}'::jsonb, TRUE)
            ELSE node
          END
          ORDER BY ordinality
        )
        FROM jsonb_array_elements(definition->'nodes') WITH ORDINALITY AS nodes(node, ordinality)
      ),
      TRUE
    ),
    needs_resave = TRUE
WHERE EXISTS (
    SELECT 1
    FROM jsonb_array_elements(definition->'nodes') AS nodes(node)
    WHERE node->>'type' = 'load-context'
      AND (node->'config' ? 'messageLimit'
        OR node->'config' ? 'characterLimit'
        OR node->'config' ? 'includeFromMe'
        OR node->'config' ? 'summaryEnabled'
        OR node->'config' ? 'summaryProviderRouteId'
        OR node->'config' ? 'compressionBatchSize')
  );
