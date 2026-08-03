ALTER TABLE messages
  ADD COLUMN content_redacted_at TIMESTAMPTZ;

CREATE INDEX messages_content_retention_idx
  ON messages (created_at, id)
  WHERE content_redacted_at IS NULL;
