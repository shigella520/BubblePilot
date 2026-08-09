ALTER TABLE ai_providers
  DROP CONSTRAINT IF EXISTS ai_providers_request_timeout_ms_check;

ALTER TABLE ai_providers
  ADD CONSTRAINT ai_providers_request_timeout_ms_check
  CHECK (request_timeout_ms BETWEEN 1000 AND 360000);
