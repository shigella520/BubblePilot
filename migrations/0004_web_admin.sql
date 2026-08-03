ALTER TABLE chats
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE INDEX chats_monitoring_updated_at_idx
  ON chats (updated_at DESC, id DESC);

CREATE TABLE admin_sessions (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at)
);

CREATE INDEX admin_sessions_active_expiry_idx
  ON admin_sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE sensitive_operation_grants (
  session_id UUID PRIMARY KEY REFERENCES admin_sessions (id) ON DELETE CASCADE,
  verified_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > verified_at)
);

CREATE INDEX sensitive_operation_grants_expiry_idx
  ON sensitive_operation_grants (expires_at);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (
    actor_type IN ('anonymous', 'session', 'api-token', 'system')
  ),
  actor_session_id UUID REFERENCES admin_sessions (id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'denied')),
  correlation_id UUID NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_events_occurred_at_idx
  ON audit_events (occurred_at DESC, id DESC);
CREATE INDEX audit_events_target_idx
  ON audit_events (target_type, target_id, occurred_at DESC);
CREATE INDEX audit_events_actor_idx
  ON audit_events (actor_session_id, occurred_at DESC)
  WHERE actor_session_id IS NOT NULL;
