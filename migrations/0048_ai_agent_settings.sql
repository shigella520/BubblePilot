CREATE TABLE ai_agent_settings (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  max_tool_calls SMALLINT NOT NULL CHECK (max_tool_calls BETWEEN 1 AND 30),
  max_tool_output_characters INTEGER NOT NULL CHECK (max_tool_output_characters BETWEEN 4000 AND 100000),
  max_tool_duration_ms INTEGER NOT NULL CHECK (max_tool_duration_ms BETWEEN 5000 AND 180000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
