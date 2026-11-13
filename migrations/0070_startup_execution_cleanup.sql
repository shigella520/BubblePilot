-- Closure metadata is separate from the original execution error and output.
ALTER TABLE workflow_executions ADD COLUMN startup_closure JSONB;
CREATE INDEX workflow_executions_startup_pending
 ON workflow_executions(id,created_at) WHERE status IN ('created','running','retrying');
