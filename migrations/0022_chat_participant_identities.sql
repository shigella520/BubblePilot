ALTER TABLE chats
  ADD COLUMN participant_identity_version INTEGER NOT NULL DEFAULT 1
    CHECK (participant_identity_version > 0);

CREATE TABLE chat_participant_identities (
  id UUID PRIMARY KEY,
  chat_id UUID NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL CHECK (LENGTH(sender_id) BETWEEN 1 AND 500),
  real_name TEXT CHECK (real_name IS NULL OR LENGTH(real_name) BETWEEN 1 AND 120),
  nickname TEXT CHECK (nickname IS NULL OR LENGTH(nickname) BETWEEN 1 AND 120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chat_id, sender_id),
  CHECK (real_name IS NOT NULL OR nickname IS NOT NULL)
);

CREATE INDEX chat_participant_identities_chat_id_idx
  ON chat_participant_identities (chat_id, sender_id);
