-- Sanitized facts about the most recent indexing failure, for operators:
-- failure kind, HTTP status, upstream request id/code, elapsed time and when.
-- Never holds provider bodies, message text or credentials. Nullable, no
-- backfill; older application versions ignore the column.
ALTER TABLE memory_jobs ADD COLUMN error_detail JSONB
  CHECK (error_detail IS NULL OR jsonb_typeof(error_detail) = 'object');
