ALTER TABLE ai_tool_executions
  ADD COLUMN request_details JSONB
    CHECK (request_details IS NULL OR jsonb_typeof(request_details) = 'object'),
  ADD COLUMN response_details JSONB
    CHECK (response_details IS NULL OR jsonb_typeof(response_details) = 'object');
