CREATE INDEX ai_provider_attempts_created_provider_idx
  ON ai_provider_attempts (created_at, provider_id);
