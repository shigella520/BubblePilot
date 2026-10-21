-- The legacy column is retained for rollback only; runtime policy reads this singleton.
CREATE TABLE network_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  trusted_fake_ip_hosts JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(trusted_fake_ip_hosts) = 'array'),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO network_settings(id, trusted_fake_ip_hosts)
VALUES (1, COALESCE((SELECT trusted_link_preview_hosts FROM ai_image_input_settings WHERE id=1), '[]'::jsonb));
