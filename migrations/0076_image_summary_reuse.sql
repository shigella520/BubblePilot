ALTER TABLE message_image_summaries
  ADD COLUMN strategy_fingerprint TEXT,
  ADD COLUMN result_origin TEXT CHECK (result_origin IN ('model', 'cache')),
  ADD COLUMN reused_from_id UUID REFERENCES message_image_summaries(id) ON DELETE SET NULL,
  ADD COLUMN reused_at TIMESTAMPTZ,
  ADD COLUMN content_lease_token UUID,
  ADD COLUMN content_wait_count INTEGER NOT NULL DEFAULT 0 CHECK (content_wait_count >= 0);

CREATE INDEX message_image_summaries_reuse_idx
  ON message_image_summaries (image_content_hash, strategy_fingerprint, generated_at DESC, id)
  WHERE status = 'succeeded' AND strategy_fingerprint IS NOT NULL;

CREATE TABLE image_summary_content_leases (
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  image_content_hash TEXT NOT NULL,
  strategy_fingerprint TEXT NOT NULL,
  job_id UUID NOT NULL REFERENCES message_image_summaries(id) ON DELETE CASCADE,
  token UUID NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (chat_id, image_content_hash, strategy_fingerprint)
);
CREATE INDEX image_summary_content_leases_expiry_idx ON image_summary_content_leases(expires_at);
CREATE INDEX image_summary_content_leases_job_idx ON image_summary_content_leases(job_id);
