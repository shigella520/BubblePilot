CREATE TABLE ai_providers (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  api_kind TEXT NOT NULL CHECK (api_kind IN ('chat-completions', 'responses')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_timeout_ms INTEGER NOT NULL CHECK (request_timeout_ms BETWEEN 1000 AND 120000),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX ai_providers_active_name_idx
  ON ai_providers (LOWER(name)) WHERE deleted_at IS NULL;
CREATE INDEX ai_providers_active_order_idx
  ON ai_providers (sort_order, id) WHERE deleted_at IS NULL AND enabled = TRUE;

CREATE TABLE ai_provider_health (
  provider_id UUID PRIMARY KEY REFERENCES ai_providers (id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'healthy' CHECK (state IN ('healthy', 'degraded', 'half-open')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  degraded_until TIMESTAMPTZ,
  half_open_claimed_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_error_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ai_provider_health_events (
  id UUID PRIMARY KEY,
  provider_id UUID NOT NULL REFERENCES ai_providers (id) ON DELETE RESTRICT,
  from_state TEXT NOT NULL CHECK (from_state IN ('healthy', 'degraded', 'half-open')),
  to_state TEXT NOT NULL CHECK (to_state IN ('healthy', 'degraded', 'half-open')),
  reason TEXT NOT NULL,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ai_provider_health_events_provider_created_idx
  ON ai_provider_health_events (provider_id, created_at DESC);

CREATE TABLE ai_provider_routes (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  current_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX ai_provider_routes_active_name_idx
  ON ai_provider_routes (LOWER(name)) WHERE deleted_at IS NULL;

CREATE TABLE ai_provider_route_versions (
  id UUID PRIMARY KEY,
  route_id UUID NOT NULL REFERENCES ai_provider_routes (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  fallback_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  retry_policy JSONB NOT NULL,
  degrade_policy JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (route_id, version)
);

ALTER TABLE ai_provider_routes
  ADD CONSTRAINT ai_provider_routes_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES ai_provider_route_versions (id) ON DELETE RESTRICT;

CREATE TABLE ai_provider_route_members (
  route_version_id UUID NOT NULL REFERENCES ai_provider_route_versions (id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES ai_providers (id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  PRIMARY KEY (route_version_id, provider_id),
  UNIQUE (route_version_id, position)
);

CREATE TABLE ai_provider_attempts (
  id UUID PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES workflow_executions (id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  route_id UUID NOT NULL REFERENCES ai_provider_routes (id) ON DELETE RESTRICT,
  route_version INTEGER NOT NULL,
  provider_id UUID NOT NULL REFERENCES ai_providers (id) ON DELETE RESTRICT,
  provider_name TEXT NOT NULL,
  provider_version INTEGER NOT NULL,
  model TEXT NOT NULL,
  round INTEGER NOT NULL CHECK (round > 0),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  selection_health_state TEXT NOT NULL CHECK (selection_health_state IN ('healthy', 'degraded', 'half-open')),
  health_state TEXT NOT NULL CHECK (health_state IN ('healthy', 'degraded', 'half-open')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  error_code TEXT,
  retryable BOOLEAN,
  fallback_allowed BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (execution_id, node_id, round, sequence)
);

CREATE INDEX ai_provider_attempts_execution_node_idx
  ON ai_provider_attempts (execution_id, node_id, round, sequence);
