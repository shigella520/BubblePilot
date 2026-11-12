ALTER TABLE scheduled_task_settings
  ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 30
  CHECK (retention_days BETWEEN 7 AND 180);
