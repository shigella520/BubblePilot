ALTER TABLE ai_providers
  ALTER COLUMN capabilities
  SET DEFAULT '{"functionCalling": false, "hostedWebSearch": false, "imageInput": false}'::jsonb,
  ALTER COLUMN capability_probe
  SET DEFAULT '{"functionCalling": "unknown", "hostedWebSearch": "unknown", "imageInput": "unknown", "checkedAt": null}'::jsonb;

UPDATE ai_providers
SET capabilities = capabilities || '{"imageInput": false}'::jsonb,
    capability_probe = capability_probe || '{"imageInput": "unknown"}'::jsonb;

CREATE TABLE ai_image_input_settings (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  include_attachments BOOLEAN NOT NULL DEFAULT TRUE,
  include_link_preview_images BOOLEAN NOT NULL DEFAULT TRUE,
  max_current_attachments SMALLINT NOT NULL CHECK (max_current_attachments BETWEEN 1 AND 10),
  max_history_images SMALLINT NOT NULL CHECK (max_history_images BETWEEN 0 AND 10),
  max_total_images SMALLINT NOT NULL CHECK (max_total_images BETWEEN 1 AND 20),
  max_image_bytes INTEGER NOT NULL CHECK (max_image_bytes BETWEEN 1024 AND 52428800),
  max_total_bytes INTEGER NOT NULL CHECK (max_total_bytes BETWEEN 1024 AND 104857600),
  fetch_timeout_ms INTEGER NOT NULL CHECK (fetch_timeout_ms BETWEEN 1000 AND 60000),
  detail TEXT NOT NULL CHECK (detail IN ('low', 'high', 'auto')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (max_total_images >= max_current_attachments),
  CHECK (max_total_bytes >= max_image_bytes)
);

CREATE TABLE ai_image_inputs (
  id UUID PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('attachment', 'link-preview')),
  source_hash TEXT NOT NULL,
  host_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'skipped', 'failed')),
  declared_mime_type TEXT,
  actual_mime_type TEXT,
  bytes INTEGER,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  detail TEXT NOT NULL CHECK (detail IN ('low', 'high', 'auto')),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ai_image_inputs_execution_idx
  ON ai_image_inputs (execution_id, created_at, id);
