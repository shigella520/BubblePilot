ALTER TABLE workflow_executions
  ADD COLUMN retry_of_execution_id UUID
    REFERENCES workflow_executions (id) ON DELETE RESTRICT,
  ADD COLUMN recovery_attempt INTEGER NOT NULL DEFAULT 0
    CHECK (recovery_attempt >= 0);

CREATE UNIQUE INDEX workflow_executions_retry_of_unique_idx
  ON workflow_executions (retry_of_execution_id)
  WHERE retry_of_execution_id IS NOT NULL;

CREATE INDEX workflow_executions_recovery_queue_idx
  ON workflow_executions (status, next_retry_at, created_at DESC, id DESC)
  WHERE status IN ('retrying', 'failed', 'dead-lettered', 'closed');
