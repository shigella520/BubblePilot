ALTER TABLE ai_providers
  ADD COLUMN tool_schema_mode TEXT NOT NULL DEFAULT 'strict'
  CHECK (tool_schema_mode IN ('strict', 'compatible'));
