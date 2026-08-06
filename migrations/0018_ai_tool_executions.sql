CREATE TABLE ai_tool_executions (
  id UUID PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES workflow_executions (id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  provider_id UUID NOT NULL REFERENCES ai_providers (id) ON DELETE RESTRICT,
  tool_call_id TEXT NOT NULL CHECK (LENGTH(tool_call_id) BETWEEN 1 AND 512),
  tool_name TEXT NOT NULL CHECK (LENGTH(tool_name) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  result_count INTEGER CHECK (result_count >= 0),
  query_hash TEXT NOT NULL CHECK (LENGTH(query_hash) = 64),
  error_code TEXT CHECK (LENGTH(error_code) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ai_tool_executions_execution_idx
  ON ai_tool_executions (execution_id, created_at, id);
