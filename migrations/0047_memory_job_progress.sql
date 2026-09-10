-- Metadata only: a fixed task membership prevents sparse cursors and cleanup
-- from being mistaken for successful indexing. No message body is retained.
ALTER TABLE memory_jobs ADD COLUMN progress_scope TEXT CHECK (progress_scope IN ('full','remaining'));
ALTER TABLE memory_jobs ADD COLUMN progress_samples JSONB NOT NULL DEFAULT '[]';
ALTER TABLE memory_jobs ADD COLUMN progress_started_at TIMESTAMPTZ;
ALTER TABLE memory_jobs ADD COLUMN progress_last_at TIMESTAMPTZ;
ALTER TABLE memory_jobs ADD COLUMN progress_worker UUID;
CREATE TABLE memory_job_items (
  job_id UUID NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE,
  message_id UUID NOT NULL,
  message_index BIGINT NOT NULL,
  characters INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processed','removed')),
  PRIMARY KEY(job_id,message_id)
);
CREATE INDEX memory_job_items_pending ON memory_job_items(job_id,message_index) WHERE state='pending';
