ALTER TABLE conversation_context_compressions
  ADD COLUMN IF NOT EXISTS preview BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS output_summary TEXT,
  ADD COLUMN IF NOT EXISTS source_compression_id UUID
    REFERENCES conversation_context_compressions (id) ON DELETE SET NULL;

DROP INDEX IF EXISTS conversation_context_compressions_active_range_key;
CREATE UNIQUE INDEX conversation_context_compressions_active_range_key
  ON conversation_context_compressions
    (context_state_id, base_version, from_index, through_index)
  WHERE status IN ('queued', 'running') AND preview = FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_context_regeneration_active_source_key
  ON conversation_context_compressions (source_compression_id)
  WHERE status IN ('queued', 'running') AND preview = TRUE;

CREATE INDEX IF NOT EXISTS conversation_context_compressions_source_idx
  ON conversation_context_compressions (source_compression_id, started_at DESC)
  WHERE source_compression_id IS NOT NULL;
