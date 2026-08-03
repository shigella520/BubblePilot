CREATE TABLE inbound_events (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored', 'completed', 'failed')),
  payload_hash TEXT NOT NULL,
  error_code TEXT,
  error_summary TEXT,
  UNIQUE (provider, external_event_id)
);

CREATE INDEX inbound_events_received_at_idx ON inbound_events (received_at DESC);
CREATE INDEX inbound_events_status_idx ON inbound_events (status, received_at DESC);

CREATE TABLE chats (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_chat_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('direct', 'group', 'unknown')),
  display_name TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_chat_id)
);

CREATE INDEX chats_enabled_updated_at_idx ON chats (enabled, updated_at DESC);

CREATE TABLE messages (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  chat_id UUID NOT NULL REFERENCES chats (id) ON DELETE RESTRICT,
  sender_id TEXT,
  sent_at TIMESTAMPTZ NOT NULL,
  body TEXT,
  content_type TEXT NOT NULL CHECK (content_type IN ('text', 'attachment', 'mixed', 'unknown')),
  is_from_me BOOLEAN NOT NULL,
  content_hash TEXT NOT NULL,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_event_id UUID NOT NULL REFERENCES inbound_events (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_message_id)
);

CREATE INDEX messages_chat_sent_at_idx ON messages (chat_id, sent_at DESC, id DESC);
