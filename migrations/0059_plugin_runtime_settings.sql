CREATE TABLE plugin_runtime_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  catalogue_characters INTEGER NOT NULL DEFAULT 64000 CHECK (catalogue_characters BETWEEN 8000 AND 256000),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO plugin_runtime_settings(id) VALUES (1);
