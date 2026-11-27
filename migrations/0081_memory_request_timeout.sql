-- Administrator-set timeout for embedding requests (indexing, query vectors
-- and connection tests). Kept outside the generation config so changing it
-- never creates a new index generation. Default matches the former fixed 15s.
ALTER TABLE memory_settings ADD COLUMN request_timeout_seconds INTEGER NOT NULL DEFAULT 15
  CHECK (request_timeout_seconds BETWEEN 5 AND 120);
