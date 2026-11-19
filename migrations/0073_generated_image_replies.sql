CREATE TABLE generated_image_artifacts (
 id uuid PRIMARY KEY,
 execution_id uuid NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
 node_id text NOT NULL,
 run_id uuid NOT NULL,
 plugin_id uuid NOT NULL,
 server text NOT NULL,
 provider_chat_id text NOT NULL,
 storage_key text NOT NULL UNIQUE,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 size integer NOT NULL CHECK(size BETWEEN 1 AND 8388608),
 width integer NOT NULL CHECK(width BETWEEN 1 AND 8192),
 height integer NOT NULL CHECK(height BETWEEN 1 AND 8192 AND width::bigint*height<=16000000),
 state text NOT NULL CHECK(state IN ('ready','bound','deleting','deleted')),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 deleted_at timestamptz,
 UNIQUE(run_id,sha256)
);
CREATE INDEX generated_image_expiry ON generated_image_artifacts(state,expires_at);
ALTER TABLE outbound_deliveries DROP CONSTRAINT outbound_deliveries_kind_check;
ALTER TABLE outbound_deliveries ADD CONSTRAINT outbound_deliveries_kind_check CHECK(kind IN ('text','meme','generated_image'));
ALTER TABLE outbound_deliveries ADD COLUMN generated_image_id uuid REFERENCES generated_image_artifacts(id) ON DELETE RESTRICT;
ALTER TABLE outbound_deliveries ADD CONSTRAINT generated_image_delivery_asset CHECK((kind='generated_image')=(generated_image_id IS NOT NULL));
CREATE TABLE outbound_reply_plans (
 id uuid PRIMARY KEY,
 execution_id uuid NOT NULL REFERENCES workflow_executions(id) ON DELETE RESTRICT,
 node_id text NOT NULL,
 artifact_id uuid NOT NULL UNIQUE REFERENCES generated_image_artifacts(id) ON DELETE RESTRICT,
 encrypted_text text,
 text_delivery_id uuid UNIQUE REFERENCES outbound_deliveries(id),
 image_delivery_id uuid NOT NULL UNIQUE REFERENCES outbound_deliveries(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(execution_id,node_id)
);
