ALTER TABLE chats
  ADD COLUMN next_message_index BIGINT NOT NULL DEFAULT 1;

ALTER TABLE messages
  ADD COLUMN message_index BIGINT;

WITH numbered AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY sent_at, id) AS position
  FROM messages
)
UPDATE messages
SET message_index = numbered.position
FROM numbered
WHERE messages.id = numbered.id;

UPDATE chats
SET next_message_index = COALESCE(latest.next_index, 1)
FROM (
  SELECT c.id, COALESCE(MAX(m.message_index), 0) + 1 AS next_index
  FROM chats c
  LEFT JOIN messages m ON m.chat_id = c.id
  GROUP BY c.id
) latest
WHERE chats.id = latest.id;

ALTER TABLE messages
  ALTER COLUMN message_index SET NOT NULL,
  ADD CONSTRAINT messages_chat_message_index_unique UNIQUE (chat_id, message_index);

CREATE TABLE conversation_context_states (
  id UUID PRIMARY KEY,
  instance_namespace TEXT NOT NULL DEFAULT 'default',
  chat_id UUID NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  covered_through_index BIGINT NOT NULL DEFAULT 0 CHECK (covered_through_index >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'compressing')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (instance_namespace, chat_id, workflow_id, node_id, profile_hash)
);

CREATE TABLE conversation_context_compressions (
  id UUID PRIMARY KEY,
  context_state_id UUID NOT NULL
    REFERENCES conversation_context_states (id) ON DELETE CASCADE,
  execution_id UUID NOT NULL REFERENCES workflow_executions (id) ON DELETE CASCADE,
  base_version INTEGER NOT NULL CHECK (base_version > 0),
  from_index BIGINT NOT NULL CHECK (from_index > 0),
  through_index BIGINT NOT NULL CHECK (through_index >= from_index),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'superseded')),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (context_state_id, base_version, from_index, through_index)
);

CREATE INDEX conversation_context_compressions_state_started_idx
  ON conversation_context_compressions (context_state_id, started_at DESC);
