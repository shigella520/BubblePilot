ALTER TABLE messages
  ADD COLUMN link_preview_status TEXT NOT NULL DEFAULT 'not-requested'
    CHECK (link_preview_status IN (
      'not-requested', 'pending', 'available', 'unavailable', 'failed', 'redacted'
    )),
  ADD COLUMN link_previews JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN link_preview_error_code TEXT,
  ADD COLUMN link_preview_diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN link_preview_fetched_at TIMESTAMPTZ;

ALTER TABLE bluebubbles_settings
  ADD COLUMN link_preview_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN open_graph_fallback_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN open_graph_timeout_ms INTEGER NOT NULL DEFAULT 5000
    CHECK (open_graph_timeout_ms BETWEEN 1000 AND 15000);
