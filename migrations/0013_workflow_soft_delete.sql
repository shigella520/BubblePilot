ALTER TABLE workflows
  ADD COLUMN deleted_at TIMESTAMPTZ;

CREATE INDEX workflows_visible_idx
  ON workflows (updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
