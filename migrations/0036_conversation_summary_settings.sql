CREATE TABLE conversation_summary_settings (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  message_limit SMALLINT NOT NULL DEFAULT 10 CHECK (message_limit BETWEEN 1 AND 50),
  character_limit INTEGER NOT NULL DEFAULT 6000 CHECK (character_limit BETWEEN 100 AND 20000),
  compression_batch_size SMALLINT NOT NULL DEFAULT 10 CHECK (compression_batch_size BETWEEN 1 AND 50),
  provider_route_id UUID REFERENCES ai_provider_routes(id) ON DELETE RESTRICT,
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
