CREATE TABLE plugins (
 id uuid PRIMARY KEY, name text NOT NULL UNIQUE, enabled boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1, revision text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE plugin_versions (
 plugin_id uuid NOT NULL REFERENCES plugins(id), hash text NOT NULL,
 package_version text NOT NULL, source jsonb NOT NULL, metadata jsonb NOT NULL,
 encrypted_config text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(plugin_id,hash), UNIQUE(plugin_id,package_version)
);
CREATE TABLE plugin_imports (
 id uuid PRIMARY KEY, state text NOT NULL, source jsonb NOT NULL,
 directories jsonb NOT NULL DEFAULT '[]', package_hash text, error_code text,
 installed_plugin_id uuid REFERENCES plugins(id), created_at timestamptz NOT NULL DEFAULT now()
);
