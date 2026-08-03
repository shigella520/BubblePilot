CREATE TABLE data_export_jobs (
  id UUID PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('session', 'api-token')),
  actor_session_id UUID REFERENCES admin_sessions (id) ON DELETE SET NULL,
  chat_id UUID NOT NULL REFERENCES chats (id) ON DELETE RESTRICT,
  sent_from TIMESTAMPTZ NOT NULL,
  sent_to TIMESTAMPTZ NOT NULL,
  include_messages BOOLEAN NOT NULL,
  include_executions BOOLEAN NOT NULL,
  snapshot_at TIMESTAMPTZ NOT NULL,
  message_count INTEGER NOT NULL CHECK (message_count >= 0),
  execution_count INTEGER NOT NULL CHECK (execution_count >= 0),
  estimated_bytes BIGINT NOT NULL CHECK (estimated_bytes >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('awaiting-confirmation', 'ready', 'revoked')
  ),
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  downloaded_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (sent_from <= sent_to),
  CHECK (include_messages OR include_executions),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'awaiting-confirmation' AND confirmed_at IS NULL AND revoked_at IS NULL)
    OR (status = 'ready' AND confirmed_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX data_export_jobs_owner_created_at_idx
  ON data_export_jobs (actor_type, actor_session_id, created_at DESC, id DESC);
CREATE INDEX data_export_jobs_expires_at_idx
  ON data_export_jobs (expires_at)
  WHERE status <> 'revoked';
