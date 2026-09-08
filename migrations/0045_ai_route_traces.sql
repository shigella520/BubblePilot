CREATE TABLE ai_route_traces (
  id UUID PRIMARY KEY,
  execution_id UUID REFERENCES workflow_executions (id) ON DELETE CASCADE,
  background_operation_id UUID,
  purpose TEXT NOT NULL
    CHECK (purpose IN ('workflow-reply', 'context-summary', 'image-summary')),
  node_id TEXT,
  route_id UUID NOT NULL,
  route_name TEXT,
  route_version INTEGER CHECK (route_version > 0),
  agent_turn INTEGER NOT NULL CHECK (agent_turn > 0),
  phase TEXT NOT NULL
    CHECK (phase IN ('standard', 'image-original', 'image-degraded')),
  request_requirements JSONB NOT NULL,
  fallback_enabled BOOLEAN,
  max_rounds INTEGER CHECK (max_rounds > 0),
  candidate_decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  terminal_status TEXT NOT NULL CHECK (terminal_status IN ('succeeded', 'failed')),
  terminal_code TEXT,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_route_traces_owner_check CHECK (
    (purpose IN ('context-summary', 'image-summary')
      AND execution_id IS NULL AND background_operation_id IS NOT NULL)
    OR
    (purpose = 'workflow-reply'
      AND execution_id IS NOT NULL AND background_operation_id IS NULL)
  )
);

CREATE INDEX ai_route_traces_execution_idx
  ON ai_route_traces (execution_id, node_id, agent_turn, created_at)
  WHERE execution_id IS NOT NULL;

CREATE INDEX ai_route_traces_background_idx
  ON ai_route_traces (background_operation_id, agent_turn, created_at)
  WHERE background_operation_id IS NOT NULL;

ALTER TABLE ai_provider_attempts
  ADD COLUMN route_trace_id UUID,
  ADD COLUMN route_phase TEXT NOT NULL DEFAULT 'standard'
    CHECK (route_phase IN ('standard', 'image-original', 'image-degraded'));

ALTER TABLE ai_provider_attempts
  DROP CONSTRAINT IF EXISTS ai_provider_attempts_execution_node_turn_round_sequence_key;

DROP INDEX IF EXISTS ai_provider_attempts_background_operation_idx;

CREATE UNIQUE INDEX ai_provider_attempts_execution_route_phase_key
  ON ai_provider_attempts
    (execution_id, node_id, agent_turn, route_phase, round, sequence)
  WHERE execution_id IS NOT NULL;

CREATE UNIQUE INDEX ai_provider_attempts_background_route_phase_key
  ON ai_provider_attempts
    (background_operation_id, agent_turn, route_phase, round, sequence)
  WHERE background_operation_id IS NOT NULL;

CREATE INDEX ai_provider_attempts_route_trace_idx
  ON ai_provider_attempts (route_trace_id, agent_turn, round, sequence)
  WHERE route_trace_id IS NOT NULL;
