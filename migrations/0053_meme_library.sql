CREATE TABLE meme_assets (
 id uuid PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '', tags jsonb NOT NULL DEFAULT '[]',
 summary text, summary_manual boolean NOT NULL DEFAULT false, candidate_summary text,
 summary_status text NOT NULL DEFAULT 'pending' CHECK (summary_status IN ('pending','processing','succeeded','failed')), summary_error text,
 enabled boolean NOT NULL DEFAULT true, mime_type text NOT NULL, size integer NOT NULL CHECK(size > 0), width integer NOT NULL, height integer NOT NULL,
 hash text NOT NULL, storage_key text NOT NULL UNIQUE, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE UNIQUE INDEX meme_assets_live_hash ON meme_assets(hash) WHERE deleted_at IS NULL;
CREATE TABLE meme_summary_jobs (
 id uuid PRIMARY KEY, meme_id uuid NOT NULL REFERENCES meme_assets(id), base_version integer NOT NULL,
 candidate boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','succeeded','failed')),
 attempt integer NOT NULL DEFAULT 0, lease_owner text, lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX meme_summary_active ON meme_summary_jobs(meme_id) WHERE status IN ('pending','processing');
CREATE INDEX meme_summary_ready ON meme_summary_jobs(next_attempt_at) WHERE status IN ('pending','processing');
ALTER TABLE ai_provider_attempts DROP CONSTRAINT ai_provider_attempts_purpose_check;
ALTER TABLE ai_provider_attempts ADD CONSTRAINT ai_provider_attempts_purpose_check CHECK(purpose IN ('workflow-reply','context-summary','image-summary','meme-summary'));
ALTER TABLE ai_provider_attempts DROP CONSTRAINT ai_provider_attempts_owner_check;
ALTER TABLE ai_provider_attempts ADD CONSTRAINT ai_provider_attempts_owner_check CHECK((purpose IN ('context-summary','image-summary','meme-summary') AND execution_id IS NULL AND background_operation_id IS NOT NULL) OR (purpose='workflow-reply' AND execution_id IS NOT NULL AND background_operation_id IS NULL));
ALTER TABLE ai_route_traces DROP CONSTRAINT ai_route_traces_purpose_check;
ALTER TABLE ai_route_traces ADD CONSTRAINT ai_route_traces_purpose_check CHECK(purpose IN ('workflow-reply','context-summary','image-summary','meme-summary'));
ALTER TABLE ai_route_traces DROP CONSTRAINT ai_route_traces_owner_check;
ALTER TABLE ai_route_traces ADD CONSTRAINT ai_route_traces_owner_check CHECK((purpose IN ('context-summary','image-summary','meme-summary') AND execution_id IS NULL AND background_operation_id IS NOT NULL) OR (purpose='workflow-reply' AND execution_id IS NOT NULL AND background_operation_id IS NULL));
ALTER TABLE outbound_deliveries ADD COLUMN kind text NOT NULL DEFAULT 'text' CHECK(kind IN ('text','meme')),
 ADD COLUMN meme_id uuid REFERENCES meme_assets(id), ADD COLUMN meme_name text, ADD COLUMN file_hash text,
 ADD COLUMN parent_delivery_id uuid REFERENCES outbound_deliveries(id), ADD COLUMN closed_at timestamptz,
 ADD COLUMN duration_ms integer, ADD COLUMN send_lease_until timestamptz;
CREATE TABLE meme_reply_plans (
 text_delivery_id uuid PRIMARY KEY REFERENCES outbound_deliveries(id) ON DELETE CASCADE,
 encrypted_text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meme_delivery_attention ON outbound_deliveries(status) WHERE kind='meme' AND closed_at IS NULL;
