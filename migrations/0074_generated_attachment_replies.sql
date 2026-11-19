-- Keep persisted image/workflow identifiers stable; the artifact model now covers files.
ALTER TABLE generated_image_artifacts ADD COLUMN filename text NOT NULL DEFAULT 'chart.png';
ALTER TABLE generated_image_artifacts ADD COLUMN mime_type text NOT NULL DEFAULT 'image/png';
ALTER TABLE generated_image_artifacts ADD COLUMN file_type text NOT NULL DEFAULT 'png';
ALTER TABLE generated_image_artifacts ALTER COLUMN width DROP NOT NULL;
ALTER TABLE generated_image_artifacts ALTER COLUMN height DROP NOT NULL;
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid='generated_image_artifacts'::regclass AND contype='c'
    AND conkey && ARRAY(SELECT attnum FROM pg_attribute WHERE attrelid='generated_image_artifacts'::regclass AND attname IN ('size','width','height'))::smallint[]
  LOOP EXECUTE format('ALTER TABLE generated_image_artifacts DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE generated_image_artifacts ADD CONSTRAINT artifact_file_size CHECK(size BETWEEN 1 AND 20971520);
ALTER TABLE generated_image_artifacts ADD CONSTRAINT artifact_filename CHECK(length(filename) BETWEEN 1 AND 160 AND filename !~ '[[:cntrl:]/\\]');
ALTER TABLE generated_image_artifacts ADD CONSTRAINT artifact_file_type CHECK(file_type IN ('png','jpeg','pdf','xlsx','csv','txt','md','zip'));
ALTER TABLE generated_image_artifacts ADD CONSTRAINT artifact_mime CHECK(mime_type = CASE file_type WHEN 'png' THEN 'image/png' WHEN 'jpeg' THEN 'image/jpeg' WHEN 'pdf' THEN 'application/pdf' WHEN 'xlsx' THEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' WHEN 'csv' THEN 'text/csv' WHEN 'txt' THEN 'text/plain' WHEN 'md' THEN 'text/markdown' WHEN 'zip' THEN 'application/zip' END);
ALTER TABLE generated_image_artifacts ADD CONSTRAINT artifact_dimensions CHECK(
  (file_type IN ('png','jpeg') AND width IS NOT NULL AND height IS NOT NULL AND width BETWEEN 1 AND 8192 AND height BETWEEN 1 AND 8192 AND width::bigint*height<=16000000 AND size<=8388608)
  OR (file_type NOT IN ('png','jpeg') AND width IS NULL AND height IS NULL));
ALTER TABLE generated_image_artifacts DROP CONSTRAINT generated_image_artifacts_run_id_sha256_key;
ALTER TABLE generated_image_artifacts ADD UNIQUE(run_id,sha256,filename,file_type);
