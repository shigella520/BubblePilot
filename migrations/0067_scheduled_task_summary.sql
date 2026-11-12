-- Display revisions must not invalidate accepted reminder executions.
ALTER TABLE scheduled_tasks
  ADD COLUMN summary TEXT CHECK (summary IS NULL OR (char_length(btrim(summary)) BETWEEN 1 AND 40 AND summary !~ E'[\\r\\n]')),
  ADD COLUMN execution_version INTEGER;
UPDATE scheduled_tasks SET execution_version = version;
ALTER TABLE scheduled_tasks ALTER COLUMN execution_version SET DEFAULT 1;
ALTER TABLE scheduled_tasks ALTER COLUMN execution_version SET NOT NULL;
ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_execution_version_positive CHECK (execution_version > 0);
