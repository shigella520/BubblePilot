CREATE TABLE workflows (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'inactive')),
  published_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE workflow_versions (
  id UUID PRIMARY KEY,
  workflow_id UUID NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'validated', 'published', 'superseded', 'invalid')
  ),
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  UNIQUE (workflow_id, version)
);

ALTER TABLE workflows
  ADD CONSTRAINT workflows_published_version_fk
  FOREIGN KEY (published_version_id) REFERENCES workflow_versions (id) ON DELETE RESTRICT;

CREATE TABLE bot_triggers (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  workflow_version_id UUID NOT NULL REFERENCES workflow_versions (id) ON DELETE RESTRICT,
  conditions JSONB NOT NULL,
  include_from_me BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX bot_triggers_enabled_updated_at_idx
  ON bot_triggers (enabled, updated_at DESC);

CREATE TABLE workflow_executions (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  source_message_id UUID REFERENCES messages (id) ON DELETE RESTRICT,
  trigger_id UUID NOT NULL REFERENCES bot_triggers (id) ON DELETE RESTRICT,
  workflow_version_id UUID NOT NULL REFERENCES workflow_versions (id) ON DELETE RESTRICT,
  correlation_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'created', 'running', 'retrying', 'succeeded', 'skipped',
      'failed', 'dead-lettered', 'closed'
    )
  ),
  current_node_id TEXT,
  error_code TEXT,
  error_summary TEXT,
  next_retry_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, external_event_id, trigger_id, workflow_version_id)
);

CREATE INDEX workflow_executions_created_at_idx
  ON workflow_executions (created_at DESC, id DESC);
CREATE INDEX workflow_executions_status_idx
  ON workflow_executions (status, created_at DESC);

CREATE TABLE node_executions (
  id UUID PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES workflow_executions (id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  node_version INTEGER NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'skipped', 'failed')),
  input_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_summary TEXT,
  retryable BOOLEAN,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  UNIQUE (execution_id, node_id, attempt)
);

CREATE INDEX node_executions_execution_started_at_idx
  ON node_executions (execution_id, started_at, id);

CREATE TABLE outbound_deliveries (
  id UUID PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES workflow_executions (id) ON DELETE RESTRICT,
  node_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  provider_chat_id TEXT NOT NULL,
  reply_to_provider_message_id TEXT,
  body_hash TEXT NOT NULL,
  provider_temp_guid UUID NOT NULL UNIQUE,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'confirmed', 'failed', 'unknown')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_summary TEXT,
  retryable BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ
);

CREATE INDEX outbound_deliveries_execution_idx
  ON outbound_deliveries (execution_id, created_at);
