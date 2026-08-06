ALTER TABLE ai_provider_attempts
  ADD COLUMN agent_turn INTEGER NOT NULL DEFAULT 1 CHECK (agent_turn > 0);

ALTER TABLE ai_provider_attempts
  DROP CONSTRAINT ai_provider_attempts_execution_id_node_id_round_sequence_key,
  ADD CONSTRAINT ai_provider_attempts_execution_node_turn_round_sequence_key
    UNIQUE (execution_id, node_id, agent_turn, round, sequence);

DROP INDEX ai_provider_attempts_execution_node_idx;

CREATE INDEX ai_provider_attempts_execution_node_idx
  ON ai_provider_attempts (execution_id, node_id, agent_turn, round, sequence);
