-- Performance pass (doc/迭代需求-性能优化.md, step 1). Index and statistics
-- changes only; no data is modified. Tables are small, so plain CREATE INDEX
-- inside the migration transaction finishes in seconds.

-- Message search → executions: avoid a full workflow_executions scan per page.
CREATE INDEX IF NOT EXISTS workflow_executions_source_message_idx
  ON workflow_executions (source_message_id)
  WHERE source_message_id IS NOT NULL;
-- Legacy executions resolve their message through the inbound event.
CREATE INDEX IF NOT EXISTS messages_source_event_idx
  ON messages (source_event_id);

-- Background workers poll every second; index only the claimable rows instead
-- of scanning thousands of finished jobs.
CREATE INDEX IF NOT EXISTS memory_jobs_claimable_idx
  ON memory_jobs (next_attempt_at, created_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS memory_jobs_chat_generation_status_idx
  ON memory_jobs (chat_id, generation_id, status);
CREATE INDEX IF NOT EXISTS bot_attribution_jobs_claimable_idx
  ON bot_attribution_jobs (created_at)
  WHERE status IN ('queued', 'running');

-- Housekeeping lookups.
CREATE INDEX IF NOT EXISTS memory_chunks_invalid_idx
  ON memory_chunks (id) WHERE NOT valid;
CREATE INDEX IF NOT EXISTS memory_retrievals_created_idx
  ON memory_retrievals (created_at);

-- Small, write-heavy tables: analyze after 2% change instead of 10%, so plans
-- follow their real size (memory_indexed_messages had never been analyzed).
ALTER TABLE memory_indexed_messages SET (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 200);
ALTER TABLE memory_jobs SET (autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE memory_job_items SET (autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE memory_chunks SET (autovacuum_analyze_scale_factor = 0.02);
-- memory_embeddings is created by prepare-memory (pgvector), so it may not
-- exist yet on a fresh install.
DO $$
BEGIN
  IF to_regclass('public.memory_embeddings') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE memory_embeddings SET (autovacuum_analyze_scale_factor = 0.02)';
    EXECUTE 'ANALYZE memory_embeddings';
  END IF;
END $$;

ANALYZE memory_indexed_messages;
ANALYZE memory_jobs;
ANALYZE memory_job_items;
ANALYZE memory_chunks;
ANALYZE messages;
ANALYZE workflow_executions;
