ALTER TABLE ai_providers
  ADD COLUMN capabilities JSONB NOT NULL DEFAULT '{"functionCalling": false, "hostedWebSearch": false}'::jsonb,
  ADD COLUMN capability_probe JSONB NOT NULL DEFAULT '{"functionCalling": "unknown", "hostedWebSearch": "unknown", "checkedAt": null}'::jsonb;
