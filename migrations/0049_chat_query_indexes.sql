-- Raw archive queries and aggregates; no extension or body index is required.
CREATE INDEX messages_readable_chat_time_idx
  ON messages(chat_id,sent_at,message_index) WHERE content_redacted_at IS NULL;
CREATE INDEX messages_readable_chat_sender_time_idx
  ON messages(chat_id,sender_id,sent_at,message_index) WHERE content_redacted_at IS NULL;
