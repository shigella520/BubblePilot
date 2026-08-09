ALTER TABLE ai_image_input_settings
  ADD COLUMN trusted_link_preview_hosts JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT ai_image_input_settings_trusted_hosts_array
    CHECK (jsonb_typeof(trusted_link_preview_hosts) = 'array');
