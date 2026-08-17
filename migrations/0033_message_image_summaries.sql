CREATE TABLE message_image_summaries (
  id UUID PRIMARY KEY,
  message_id UUID NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('attachment', 'link-preview')),
  source_key TEXT NOT NULL CHECK (LENGTH(source_key) BETWEEN 1 AND 4096),
  attachment_ref TEXT NOT NULL CHECK (LENGTH(attachment_ref) BETWEEN 1 AND 255),
  image_content_hash TEXT,
  summary TEXT CHECK (summary IS NULL OR LENGTH(summary) BETWEEN 1 AND 2000),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'processing', 'succeeded', 'failed', 'unavailable', 'redacted'
  )),
  provider_id UUID REFERENCES ai_providers (id) ON DELETE SET NULL,
  provider_name TEXT,
  model TEXT,
  contract_version TEXT NOT NULL DEFAULT 'image-summary-v1',
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  error_code TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, source_type, source_key)
);

CREATE INDEX message_image_summaries_pending_idx
  ON message_image_summaries (next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');

CREATE INDEX message_image_summaries_message_idx
  ON message_image_summaries (message_id, attachment_ref, created_at DESC);

ALTER TABLE ai_provider_attempts
  ALTER COLUMN execution_id DROP NOT NULL,
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'workflow-reply'
    CHECK (purpose IN ('workflow-reply', 'context-summary', 'image-summary')),
  ADD COLUMN background_operation_id UUID;

ALTER TABLE ai_provider_attempts
  ADD CONSTRAINT ai_provider_attempts_owner_check CHECK (
    (purpose = 'image-summary' AND execution_id IS NULL AND background_operation_id IS NOT NULL)
    OR
    (purpose <> 'image-summary' AND execution_id IS NOT NULL AND background_operation_id IS NULL)
  );

CREATE UNIQUE INDEX ai_provider_attempts_background_operation_idx
  ON ai_provider_attempts (background_operation_id, agent_turn, round, sequence)
  WHERE background_operation_id IS NOT NULL;
