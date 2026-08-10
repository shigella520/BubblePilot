ALTER TABLE ai_providers
  ADD COLUMN session_affinity TEXT NOT NULL DEFAULT 'disabled'
  CHECK (session_affinity IN ('disabled', 'session-id-header'));
