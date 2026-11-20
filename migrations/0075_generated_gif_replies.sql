-- Expand the existing artifact contract; retain original GIF bytes in .file storage.
ALTER TABLE generated_image_artifacts DROP CONSTRAINT artifact_file_type;
ALTER TABLE generated_image_artifacts ADD CONSTRAINT artifact_file_type
  CHECK(file_type IN ('png','jpeg','gif','pdf','xlsx','csv','txt','md','zip'));
ALTER TABLE generated_image_artifacts DROP CONSTRAINT artifact_mime;
ALTER TABLE generated_image_artifacts ADD CONSTRAINT artifact_mime CHECK(mime_type = CASE file_type
  WHEN 'png' THEN 'image/png' WHEN 'jpeg' THEN 'image/jpeg' WHEN 'gif' THEN 'image/gif'
  WHEN 'pdf' THEN 'application/pdf' WHEN 'xlsx' THEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  WHEN 'csv' THEN 'text/csv' WHEN 'txt' THEN 'text/plain' WHEN 'md' THEN 'text/markdown' WHEN 'zip' THEN 'application/zip' END);
ALTER TABLE generated_image_artifacts DROP CONSTRAINT artifact_dimensions;
ALTER TABLE generated_image_artifacts ADD CONSTRAINT artifact_dimensions CHECK(
  (file_type IN ('png','jpeg','gif') AND width IS NOT NULL AND height IS NOT NULL
    AND width BETWEEN 1 AND 8192 AND height BETWEEN 1 AND 8192
    AND width::bigint*height<=16000000 AND size<=8388608)
  OR (file_type NOT IN ('png','jpeg','gif') AND width IS NULL AND height IS NULL));
