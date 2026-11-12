-- Minimal tombstones preserve creation idempotency after task payload deletion.
CREATE TABLE scheduled_task_deletions (
 task_id UUID PRIMARY KEY,
 creation_key TEXT NOT NULL UNIQUE,
 version INTEGER NOT NULL,
 reason TEXT NOT NULL CHECK (reason IN ('manual','retention')),
 deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_tasks_retention ON scheduled_tasks(finished_at,id)
 WHERE lifecycle IN ('completed','cancelled');
