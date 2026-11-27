-- Performance pass, P1 query rewrites (doc/迭代需求-性能优化.md). Indexes only;
-- no data is modified. Tables are small, so plain CREATE INDEX inside the
-- migration transaction finishes in seconds.

-- Message keyword search: lower(body) LIKE '%term%' via trigrams. Redacted rows
-- have no body and are never searchable, so they are left out of the index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS messages_body_trgm_idx
  ON messages USING gin (lower(body) gin_trgm_ops)
  WHERE content_redacted_at IS NULL;
-- Global (all chats) message search orders by sent time.
CREATE INDEX IF NOT EXISTS messages_sent_at_id_idx
  ON messages (sent_at DESC, id DESC);

-- Operations status: deliveries needing attention are a tiny subset.
CREATE INDEX IF NOT EXISTS outbound_deliveries_attention_idx
  ON outbound_deliveries (status)
  WHERE status IN ('sending', 'unknown');

-- AI usage: per-provider time ranges (usage series and period totals).
CREATE INDEX IF NOT EXISTS ai_provider_attempts_provider_created_idx
  ON ai_provider_attempts (provider_id, created_at);

ANALYZE messages;
ANALYZE outbound_deliveries;
ANALYZE ai_provider_attempts;
