CREATE TABLE meme_collections (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120 AND name=btrim(name) AND name NOT IN ('全部表情','未分类')),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=2000),
 cover_meme_id uuid REFERENCES meme_assets(id), version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX meme_collection_name ON meme_collections(lower(name));
ALTER TABLE meme_assets ADD COLUMN collection_id uuid REFERENCES meme_collections(id),
 ADD COLUMN collection_joined_at timestamptz, ADD COLUMN summary_input_version integer NOT NULL DEFAULT 1;
CREATE INDEX meme_collection_members ON meme_assets(collection_id,collection_joined_at,id) WHERE deleted_at IS NULL;
-- NULL keeps pre-upgrade jobs on the original conservative version check.
ALTER TABLE meme_summary_jobs ADD COLUMN input_version integer;
