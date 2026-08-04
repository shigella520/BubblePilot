ALTER TABLE bot_triggers
  ADD COLUMN deleted_at TIMESTAMPTZ;

CREATE INDEX bot_triggers_visible_idx
  ON bot_triggers (updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
