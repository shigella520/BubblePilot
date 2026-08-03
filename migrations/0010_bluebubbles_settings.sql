CREATE TABLE bluebubbles_settings (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  server_url TEXT NOT NULL,
  encrypted_access_token TEXT NOT NULL,
  encrypted_webhook_secret TEXT NOT NULL,
  send_method TEXT NOT NULL CHECK (
    send_method IN ('private-api', 'apple-script')
  ),
  request_timeout_ms INTEGER NOT NULL CHECK (
    request_timeout_ms BETWEEN 1000 AND 120000
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
